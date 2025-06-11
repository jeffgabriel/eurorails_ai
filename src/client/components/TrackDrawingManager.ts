import 'phaser';
import { GameState, TerrainType, GridPoint } from '../../shared/types/GameTypes';
import { TrackSegment, PlayerTrackState, TrackBuildError } from '../../shared/types/TrackTypes';
import { MapRenderer } from './MapRenderer';

export class TrackDrawingManager {
    private scene: Phaser.Scene;
    private mapContainer: Phaser.GameObjects.Container;
    private drawingGraphics: Phaser.GameObjects.Graphics;
    private previewGraphics: Phaser.GameObjects.Graphics;
    private gameState: GameState;
    private playerTracks: Map<string, PlayerTrackState>;
    private gridPoints: GridPoint[][];
    
    // Performance optimization caches
    private networkNodesCache: Map<string, Set<string>> = new Map();
    private lastHoverPoint: { row: number; col: number } | null = null;
    private pathCache: Map<string, GridPoint[] | null> = new Map();
    private hoverThrottleTimer: number | null = null;
    
    // Drawing mode state
    private isDrawingMode: boolean = false;
    private currentSegments: TrackSegment[] = [];
    private lastClickedPoint: GridPoint | null = null;
    private turnBuildCost: number = 0;
    private validConnectionPoints: Set<GridPoint> = new Set();
    private previewPath: GridPoint[] = [];
    
    // Track building costs
    private readonly MAX_TURN_BUILD_COST = 20; // 20M ECU per turn
    private readonly TERRAIN_COSTS: { [key in TerrainType]: number } = {
        [TerrainType.Clear]: 1,
        [TerrainType.Mountain]: 2,
        [TerrainType.Alpine]: 5,
        [TerrainType.SmallCity]: 3,
        [TerrainType.MediumCity]: 3,
        [TerrainType.MajorCity]: 5,
        [TerrainType.Water]: 0,
        [TerrainType.FerryPort]: 0
    };

    private gameStateService: any; // Using 'any' to avoid circular dependency
    
    // Callback for cost updates
    private onCostUpdateCallback: ((cost: number) => void) | null = null;
    
    // Add this property to track the last displayed cost
    private lastDisplayedCost: number = 0;
    
    // Add this property to track the last path key
    private lastPathKey: string = '';
    
    // Add this property to track pending hover points
    private pendingHoverPoint: GridPoint | null = null;
    
    // Add cost update queue
    private costUpdateQueue: {
        path: GridPoint[],
        cost: number,
        timestamp: number
    } | null = null;
    
    // Add property to store the update event handler
    private updateEventHandler: (() => void) | null = null;
    
    constructor(
        scene: Phaser.Scene, 
        mapContainer: Phaser.GameObjects.Container, 
        gameState: GameState,
        gridPoints: GridPoint[][],
        gameStateService?: any // Using 'any' to avoid circular dependency
    ) {
        this.scene = scene;
        this.mapContainer = mapContainer;
        this.gameState = gameState;
        this.gridPoints = gridPoints;
        this.playerTracks = new Map();
        this.gameStateService = gameStateService;
        
        // Initialize drawing graphics
        this.drawingGraphics = this.scene.add.graphics();
        this.drawingGraphics.setDepth(1);
        this.mapContainer.add(this.drawingGraphics);
        
        this.previewGraphics = this.scene.add.graphics();
        this.previewGraphics.setDepth(2);  // Set higher depth to appear above tracks
        this.mapContainer.add(this.previewGraphics);

        // Setup cost update handler
        this.setupCostUpdateHandler();
    }
    
    private setupCostUpdateHandler(): void {
        // Store the handler function so we can remove it later
        this.updateEventHandler = () => {
            if (this.costUpdateQueue) {
                const now = Date.now();
                // Only update if we've been hovering for at least 100ms
                if (now - this.costUpdateQueue.timestamp > 100) {
                    this.processCostUpdate();
                }
            }
        };
        
        this.scene.events.on('update', this.updateEventHandler);
    }

    private processCostUpdate(): void {
        if (!this.costUpdateQueue || !this.onCostUpdateCallback) return;

        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        const playerTrackState = this.playerTracks.get(currentPlayer.id);
        const previousSessionsCost = playerTrackState ? playerTrackState.turnBuildCost : 0;
        const totalCost = previousSessionsCost + this.costUpdateQueue.cost;

        // Only update if the cost has changed
        if (this.lastDisplayedCost !== totalCost) {
            this.lastDisplayedCost = totalCost;
            this.onCostUpdateCallback(totalCost);
        }

        // Clear the queue
        this.costUpdateQueue = null;
    }

    private queueCostUpdate(path: GridPoint[], cost: number): void {
        // Generate a unique key for this path
        const pathKey = path.map(p => `${p.row},${p.col}`).join('|');
        
        // Only queue if the path is different from the last one
        if (pathKey !== this.lastPathKey) {
            this.lastPathKey = pathKey;
            this.costUpdateQueue = {
                path,
                cost,
                timestamp: Date.now()
            };
        }
    }

    // Method to register a callback when the track cost changes
    public onCostUpdate(callback: (cost: number) => void): void {
        this.onCostUpdateCallback = callback;
    }

    public getPlayerTrackState(playerId: string): PlayerTrackState | undefined {
        return this.playerTracks.get(playerId);
    }

    public async loadExistingTracks(): Promise<void> {
        try {
            // Fetch all tracks for the current game
            const response = await fetch(`/api/tracks/${this.gameState.id}`);
            if (!response.ok) {
                throw new Error(await response.text());
                return;
            }

            const tracks: PlayerTrackState[] = await response.json();
            
            // Initialize playerTracks Map with loaded data
            tracks.forEach(trackState => {
                this.playerTracks.set(trackState.playerId, trackState);
            });

            // Draw all loaded tracks
            this.drawAllTracks();
            
        } catch (error) {
            throw error;
        }
    }

    public drawAllTracks(): void {
        // Clear existing tracks
        this.drawingGraphics.clear();
        
        // Draw all tracks for each player
        this.playerTracks.forEach((trackState, playerId) => {
            const player = this.gameState.players.find(p => p.id === playerId);
            if (player) {
                const color = parseInt(player.color.replace('#', '0x'));
                trackState.segments.forEach(segment => {
                    this.drawingGraphics.lineStyle(3, color, 1);
                    this.drawingGraphics.beginPath();
                    this.drawingGraphics.moveTo(segment.from.x, segment.from.y);
                    this.drawingGraphics.lineTo(segment.to.x, segment.to.y);
                    this.drawingGraphics.strokePath();
                });
            }
        });
    }

    public toggleDrawingMode(): boolean {
        // Toggle drawing mode state
        const oldMode = this.isDrawingMode;
        this.isDrawingMode = !this.isDrawingMode;
        
        if (this.isDrawingMode) {
            this.initializeDrawingMode();
        } else {
            this.saveCurrentTracks();
            this.cleanupDrawingMode();
        }
        
        return this.isDrawingMode;
    }
    
    public get isInDrawingMode(): boolean {
        return this.isDrawingMode;
    }
    
    public getCurrentTurnBuildCost(): number {
        return this.turnBuildCost;
    }
    
    // Get the latest build cost for the current player
    public getLastBuildCost(playerId: string): number {
        const playerTrackState = this.playerTracks.get(playerId);
        return playerTrackState ? playerTrackState.turnBuildCost : 0;
    }
    
    // Clear the last build cost for a player after processing turn change
    public async clearLastBuildCost(playerId: string): Promise<void> {
        const playerTrackState = this.playerTracks.get(playerId);
        if (playerTrackState) {
            // Reset the turn build cost to zero
            playerTrackState.turnBuildCost = 0;
            
            // Save the updated track state to the database
            try {
                const response = await fetch('/api/tracks/save', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        gameId: this.gameState.id,
                        playerId: playerId,
                        trackState: playerTrackState
                    })
                });
                
                if (!response.ok) {
                    throw new Error('Failed to clear turn build cost in database');
                }
            } catch (error) {
                throw error;
            }
        }
    }
    
    // Helper method to check if a cost is valid against both turn budget and player money
    private isValidCost(additionalCost: number): boolean {
        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        const playerMoney = currentPlayer.money;
        
        // Get the current accumulated cost from previous sessions in this turn
        const playerTrackState = this.playerTracks.get(currentPlayer.id);
        const previousSessionsCost = playerTrackState ? playerTrackState.turnBuildCost : 0;
        
        // Total existing cost includes previous sessions and current unsaved session
        const totalExistingCost = previousSessionsCost + this.turnBuildCost;
        
        // Check against both the turn budget and the player's available money
        const isWithinBudget = totalExistingCost + additionalCost <= this.MAX_TURN_BUILD_COST;
        const isWithinMoney = totalExistingCost + additionalCost <= playerMoney;
        
        return isWithinBudget && isWithinMoney;
    }

    private async saveCurrentTracks(): Promise<void> {
        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        
        // Get or create track state for current player
        let playerTrackState = this.playerTracks.get(currentPlayer.id);
        if (!playerTrackState) {
            playerTrackState = {
                playerId: currentPlayer.id,
                gameId: this.gameState.id,
                segments: [],
                totalCost: 0,
                turnBuildCost: 0,
                lastBuildTimestamp: new Date()
            };
            this.playerTracks.set(currentPlayer.id, playerTrackState);
        }

        // Add new segments to player's track state
        if (this.currentSegments.length > 0 && playerTrackState) {
            playerTrackState.segments.push(...this.currentSegments);
            playerTrackState.totalCost += this.turnBuildCost;
            
            // Accumulate the turn build cost rather than overwriting it
            playerTrackState.turnBuildCost += this.turnBuildCost;
            
            playerTrackState.lastBuildTimestamp = new Date();
            
            try {
                // Save track state to database
                const response = await fetch('/api/tracks/save', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        gameId: this.gameState.id,
                        playerId: currentPlayer.id,
                        trackState: playerTrackState
                    })
                });

                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(JSON.stringify(errorData));
                    return;
                }
                
                // Update player's money if we have track building cost and gameStateService
                if (this.turnBuildCost > 0 && this.gameStateService) {
                    // Calculate new money amount
                    const newMoney = currentPlayer.money - this.turnBuildCost;
                    
                    // Update money both locally and in the database
                    const moneyUpdateSuccess = await this.gameStateService.updatePlayerMoney(
                        currentPlayer.id, 
                        newMoney
                    );
                    
                    if (!moneyUpdateSuccess) {
                        throw new Error('Failed to update player money');
                    }
                }
            } catch (error) {
                throw error;
            }
        }
    }

    private initializeDrawingMode(): void {
        // Clear any existing graphics and redraw all permanent tracks
        this.drawingGraphics.clear();
        this.previewGraphics.clear();
        this.drawAllTracks();

        // Reset current session's drawing state
        this.currentSegments = [];
        this.lastClickedPoint = null;
        this.lastHoverPoint = null;
        
        // Clear performance caches
        this.networkNodesCache.clear();
        this.pathCache.clear();
        
        // Reset the current session's build cost, but keep track of the accumulated cost for the turn
        // We'll get the current player's total build cost for the notification
        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        const playerTrackState = this.playerTracks.get(currentPlayer.id);
        const accumulatedCost = playerTrackState ? playerTrackState.turnBuildCost : 0;
        
        // Reset only the current session cost
        this.turnBuildCost = 0;
        
        // Notify about the accumulated cost for the turn
        if (this.onCostUpdateCallback) {
            this.onCostUpdateCallback(accumulatedCost);
        }

        // Set up input handlers for drawing mode
        this.scene.input.on('pointerdown', this.handleDrawingClick, this);
        this.scene.input.on('pointermove', this.handleDrawingHover, this);
    }

    private cleanupDrawingMode(): void {
        // Remove input handlers
        this.scene.input.off('pointerdown', this.handleDrawingClick, this);
        this.scene.input.off('pointermove', this.handleDrawingHover, this);

        // Clear any pending hover timer
        if (this.hoverThrottleTimer !== null) {
            window.clearTimeout(this.hoverThrottleTimer);
            this.hoverThrottleTimer = null;
        }

        // Clear the graphics objects and redraw all permanent tracks
        this.drawingGraphics.clear();
        this.previewGraphics.clear();
        this.drawAllTracks();

        // Reset drawing state
        this.currentSegments = [];
        this.lastClickedPoint = null;
        this.lastHoverPoint = null;
        this.turnBuildCost = 0;
        
        // Clear performance caches
        this.networkNodesCache.clear();
        this.pathCache.clear();

        // Clear cost update queue
        this.costUpdateQueue = null;
        this.lastPathKey = '';
    }

    private handleDrawingClick(pointer: Phaser.Input.Pointer): void {
        if (!this.isDrawingMode || !pointer.leftButtonDown()) {
            return;
        }

        // Ignore clicks in UI area
        if (pointer.y > this.scene.scale.height - 200) {
            return;
        }

        const clickedPoint = this.scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
        // Find the grid point at this position
        const gridPoint = this.getGridPointAtPosition(clickedPoint.x, clickedPoint.y);
        if (!gridPoint || gridPoint.terrain === TerrainType.Water) {
            return;
        }

        // Get current player information
        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        const playerTrackState = this.playerTracks.get(currentPlayer.id);
        // Handle first click (starting point) - still needed to initialize the pathfinding
        if (!this.lastClickedPoint) {
            // Check if this point is either a major city or a connected point of a major city
            const isMajorCity = gridPoint.city?.type === TerrainType.MajorCity;
            const isConnectedPointOfMajorCity = this.isConnectedPointOfMajorCity(gridPoint);
            const isConnectedToNetwork = this.isPointConnectedToNetwork(gridPoint, playerTrackState);
            if (!isMajorCity && !isConnectedPointOfMajorCity && !isConnectedToNetwork) {
                return;
            }
            
            this.lastClickedPoint = gridPoint;
            this.updateValidConnectionPoints();
            return;
        }

        // If we have a valid preview path to this point, use it
        if (this.previewPath.length > 0 && 
            this.previewPath[this.previewPath.length - 1].row === gridPoint.row && 
            this.previewPath[this.previewPath.length - 1].col === gridPoint.col) {
            
            // Verify no water points in the path
            if (this.previewPath.some(point => point.terrain === TerrainType.Water)) {
                return;
            }
            
            // Calculate total cost of the path to check against player's money and turn budget
            let totalPathCost = 0;
            for (let i = 0; i < this.previewPath.length - 1; i++) {
                const fromPoint = this.previewPath[i];
                const toPoint = this.previewPath[i + 1];
                
                // Skip cost for existing segments
                if (this.isSegmentInNetwork(fromPoint, toPoint, playerTrackState)) {
                    continue;
                }
                
                let segmentCost = this.calculateTrackCost(fromPoint, toPoint);
                segmentCost = Math.floor(segmentCost);
                totalPathCost += segmentCost;
            }
            
            // Check if the total cost is valid
            if (!this.isValidCost(totalPathCost)) {
                return;
            }
            
            // Create segments from the path
            for (let i = 0; i < this.previewPath.length - 1; i++) {
                const fromPoint = this.previewPath[i];
                const toPoint = this.previewPath[i + 1];
                
                // Skip if this segment already exists in the player's network
                if (this.isSegmentInNetwork(fromPoint, toPoint, playerTrackState)) {
                    continue;
                }
                
                // Calculate cost (rounding to ensure it's an integer)
                let segmentCost = this.calculateTrackCost(fromPoint, toPoint);
                // Round down to ensure we have an integer cost for the actual track
                segmentCost = Math.floor(segmentCost);
                
                const segment: TrackSegment = {
                    from: {
                        x: fromPoint.x,
                        y: fromPoint.y,
                        row: fromPoint.row,
                        col: fromPoint.col,
                        terrain: fromPoint.terrain
                    },
                    to: {
                        x: toPoint.x,
                        y: toPoint.y,
                        row: toPoint.row,
                        col: toPoint.col,
                        terrain: toPoint.terrain
                    },
                    cost: segmentCost
                };

                // Add and draw the segment
                this.currentSegments.push(segment);
                this.drawTrackSegment(segment);
                this.turnBuildCost += segmentCost;
                
                // Clear network cache since we added a segment
                this.networkNodesCache.clear();
                
                // If we've reached a ferry port, create the ferry connection
                if (toPoint.terrain === TerrainType.FerryPort && toPoint.ferryConnection) {
                    const ferryConnection = toPoint.ferryConnection;
                    const otherEnd = ferryConnection.connections.find(p => 
                        p.row !== toPoint.row || p.col !== toPoint.col
                    );
                    
                    if (otherEnd) {
                        // Find the actual grid point for the other end to get correct coordinates
                        const otherEndGridPoint = this.gridPoints[otherEnd.row][otherEnd.col];
                        if (!otherEndGridPoint) {
                            break;
                        }

                        // Update the last clicked point to be the other end of the ferry
                        // This will start a new track segment from the other ferry port
                        this.lastClickedPoint = otherEndGridPoint;
                        
                        // Break out of the loop since we've reached a ferry port
                        break;
                    }
                }
                
                // Get the current accumulated cost for this turn (reuse the playerTrackState from above)
                const previousSessionsCost = playerTrackState ? playerTrackState.turnBuildCost : 0;
                
                // Calculate the total cost including current session and previous sessions
                const totalTurnCost = previousSessionsCost + this.turnBuildCost;
                
                // Notify about cost update with the total cost
                if (this.onCostUpdateCallback) {
                    this.onCostUpdateCallback(totalTurnCost);
                }
            }

            // After adding track, update last clicked point and valid connection points
            // Now this includes the most recently added track segments
            if (gridPoint.terrain !== TerrainType.FerryPort) {
                this.lastClickedPoint = gridPoint;
            }
            this.updateValidConnectionPoints();
        }
    }

    private handleDrawingHover(pointer: Phaser.Input.Pointer): void {
        if (!this.isDrawingMode || !this.lastClickedPoint) {
            this.previewGraphics.clear();
            this.previewPath = [];
            // this.updateCostDisplayToCommitted();
            return;
        }

        const hoverPoint = this.scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
        const gridPoint = this.getGridPointAtPosition(hoverPoint.x, hoverPoint.y);
        if (!gridPoint || gridPoint.terrain === TerrainType.Water) {
            this.previewGraphics.clear();
            this.previewPath = [];
            // this.updateCostDisplayToCommitted();
            return;
        }

        // Skip if hovering over the last clicked point - compare coordinates instead of object reference
        if (gridPoint.row === this.lastClickedPoint.row && gridPoint.col === this.lastClickedPoint.col) {
            this.previewGraphics.clear();
            this.previewPath = [];
            // this.updateCostDisplayToCommitted();
            return;
        }

        // Skip if we're already hovering over the same point
        if (this.lastHoverPoint && 
            this.lastHoverPoint.row === gridPoint.row && 
            this.lastHoverPoint.col === gridPoint.col) {
            return; // No need to recalculate
        }

        // Update last hover point immediately to ensure smooth tracking
        this.lastHoverPoint = { row: gridPoint.row, col: gridPoint.col };

        // Store the most recent hover point for processing
        this.pendingHoverPoint = gridPoint;

        // Throttle hover updates to reduce calculation frequency
        if (this.hoverThrottleTimer !== null) {
            return;
        }

        this.hoverThrottleTimer = window.setTimeout(() => {
            this.hoverThrottleTimer = null;
            if (this.pendingHoverPoint) {
                this.processHoverUpdate(this.pendingHoverPoint);
                this.pendingHoverPoint = null;
            }
        }, 16); // Reduced to ~60fps for smoother updates
    }

    private processHoverUpdate(gridPoint: GridPoint): void {
        // If the last clicked point is a ferry port, find the other end of the ferry
        const initialStartPoint = this.lastClickedPoint;
        if (!initialStartPoint) return;
        
        let startPoint: GridPoint = initialStartPoint;
        if (startPoint.terrain === TerrainType.FerryPort && startPoint.ferryConnection) {
            const currentRow = startPoint.row;
            const currentCol = startPoint.col;
            const otherEnd = startPoint.ferryConnection.connections.find(p => 
                p.row !== currentRow || p.col !== currentCol
            );
            if (otherEnd) {
                const otherEndPoint = this.gridPoints[otherEnd.row][otherEnd.col];
                if (otherEndPoint) {
                    startPoint = otherEndPoint;
                }
            }
        }

        // Find path to hover point
        const path = this.findPreviewPath(gridPoint);

        if (!path || path.length === 0) {
            this.previewGraphics.clear();
            this.previewPath = [];
            return;
        }

        // Store the valid path
        this.previewPath = path;

        // Calculate the cost of the preview path
        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        const playerTrackState = this.playerTracks.get(currentPlayer.id);
        let previewCost = 0;
        
        for (let i = 0; i < path.length - 1; i++) {
            const fromPoint = path[i];
            const toPoint = path[i + 1];
            
            // Skip cost for existing segments
            if (!this.isSegmentInNetwork(fromPoint, toPoint, playerTrackState)) {
                const segmentCost = Math.floor(this.calculateTrackCost(fromPoint, toPoint));
                previewCost += segmentCost;
            }
        }
        
        // Queue the cost update instead of updating immediately
        this.queueCostUpdate(path, previewCost);

        // Draw the preview path with color based on validity
        this.previewGraphics.clear();
        
        // Check if cost is valid
        const isValidCost = this.isValidCost(previewCost);
        const lineColor = isValidCost ? 0x00ff00 : 0xff0000; // Green if valid, red if not
        
        this.previewGraphics.lineStyle(2, lineColor, 0.5);
        
        // Draw lines connecting all points in the path
        this.previewGraphics.beginPath();
        this.previewGraphics.moveTo(path[0].x, path[0].y);
        for (let i = 1; i < path.length; i++) {
            this.previewGraphics.lineTo(path[i].x, path[i].y);
        }
        this.previewGraphics.strokePath();
    }

    public getGridPointAtPosition(worldX: number, worldY: number): GridPoint | null {
        // Define maximum distance for point selection
        const MAX_DISTANCE = 15; // pixels
        
        let closestPoint: GridPoint | null = null;
        let minDistance = MAX_DISTANCE;
        // Check points in a 3x3 grid area around the cursor
        const GRID_MARGIN = MapRenderer.GRID_MARGIN; 
        const VERTICAL_SPACING = MapRenderer.VERTICAL_SPACING;
        const HORIZONTAL_SPACING = MapRenderer.HORIZONTAL_SPACING;
        
        const approxRow = Math.floor((worldY - GRID_MARGIN) / VERTICAL_SPACING);
        
        // For hexagonal grid, we need to account for the offset on odd rows
        // First, calculate the column without offset
        let approxCol = Math.floor((worldX - GRID_MARGIN) / HORIZONTAL_SPACING);
        
        // If we're on an odd row, we need to adjust for the horizontal offset
        const isOffsetRow = approxRow % 2 === 1;
        if (isOffsetRow) {
            // On odd rows, points are shifted right by HORIZONTAL_SPACING / 2
            // So we need to adjust the column calculation
            approxCol = Math.floor((worldX - GRID_MARGIN - HORIZONTAL_SPACING / 2) / HORIZONTAL_SPACING);
        }

        // Search in a 3x3 area around the approximate position
        for (let r = Math.max(0, approxRow - 1); r <= Math.min(this.gridPoints.length - 1, approxRow + 1); r++) {
            if (!this.gridPoints[r]) continue;
            
            for (let c = Math.max(0, approxCol - 1); c <= Math.min(this.gridPoints[r].length - 1, approxCol + 1); c++) {
                const point = this.gridPoints[r][c];
                if (!point) continue;

                // Defensive: Skip points with missing terrain or empty id
                if (typeof point.terrain === 'undefined' || point.id === '') continue;

                // Skip water points
                if (point.terrain === TerrainType.Water) continue;

                // Calculate distance to this point
                const dx = point.x - worldX;
                const dy = point.y - worldY;
                const distance = Math.sqrt(dx * dx + dy * dy);

                // Update closest point if this is closer
                if (distance <= minDistance) {
                    minDistance = distance;
                    closestPoint = point;
                }
            }
        }
        return closestPoint;
    }

    private findPreviewPath(targetPoint: GridPoint): GridPoint[] | null {
        // Immediately return null if target point is water
        if (targetPoint.terrain === TerrainType.Water) {
            return null;
        }

        // Get the current player's track state once
        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        const playerTrackState = this.playerTracks.get(currentPlayer.id);
        
        // Initialize Dijkstra's algorithm data structures
        const distances = new Map<string, number>();
        const previous = new Map<string, GridPoint>();
        const unvisited = new Set<string>();

        // Helper function to get point key for maps
        const getPointKey = (p: GridPoint) => `${p.row},${p.col}`;

        // Use lastClickedPoint as the starting point
        const startPoint = this.lastClickedPoint;
        if (!startPoint) {
            return null;
        }

        // Skip if target is the same as start point
        if (targetPoint.row === startPoint.row && targetPoint.col === startPoint.col) {
            return null;
        }

        // Limit preview distance to prevent expensive calculations
        const distance = Math.abs(targetPoint.row - startPoint.row) + Math.abs(targetPoint.col - startPoint.col);
        if (distance > 15) {  // Maximum Manhattan distance
            return null;
        }

        // Calculate search area with smaller, more reasonable margins
        const rowDiff = Math.abs(targetPoint.row - startPoint.row);
        const colDiff = Math.abs(targetPoint.col - startPoint.col);
        const margin = Math.min(5, Math.max(rowDiff, colDiff) / 2); // Adaptive margin, max 5
        const minRow = Math.max(0, Math.min(startPoint.row, targetPoint.row) - Math.floor(margin));
        const maxRow = Math.min(this.gridPoints.length - 1, Math.max(startPoint.row, targetPoint.row) + Math.ceil(margin));
        const minCol = Math.max(0, Math.min(startPoint.col, targetPoint.col) - Math.floor(margin));
        const maxCol = Math.min(this.gridPoints[0]?.length - 1 || 0, Math.max(startPoint.col, targetPoint.col) + Math.ceil(margin));

        // Initialize all points with infinity distance within the search area
        let pointCount = 0;
        for (let r = minRow; r <= maxRow; r++) {
            if (!this.gridPoints[r]) continue;
            for (let c = minCol; c <= maxCol; c++) {
                const point = this.gridPoints[r][c];
                if (!point || point.terrain === TerrainType.Water) continue;
                const key = getPointKey(point);
                distances.set(key, Infinity);
                unvisited.add(key);
                pointCount++;
            }
        }

        // Get cached network nodes or build them
        const cacheKey = `${currentPlayer.id}_${this.currentSegments.length}`;
        let networkNodes = this.networkNodesCache.get(cacheKey);
        
        if (!networkNodes) {
            networkNodes = new Set<string>();
            if (playerTrackState) {
                for (const segment of playerTrackState.segments) {
                    networkNodes.add(getPointKey({ row: segment.from.row, col: segment.from.col } as GridPoint));
                    networkNodes.add(getPointKey({ row: segment.to.row, col: segment.to.col } as GridPoint));
                }
                
                // Also add current segments being built in this session
                for (const segment of this.currentSegments) {
                    networkNodes.add(getPointKey({ row: segment.from.row, col: segment.from.col } as GridPoint));
                    networkNodes.add(getPointKey({ row: segment.to.row, col: segment.to.col } as GridPoint));
                }
            }
            this.networkNodesCache.set(cacheKey, networkNodes);
        }

        // Set distance to 0 for the clicked point and all nodes in the player's network
        distances.set(getPointKey(startPoint), 0);
        if (!unvisited.has(getPointKey(startPoint))) {
            unvisited.add(getPointKey(startPoint));
            pointCount++;
        }
        
        // Set all nodes in player's network to zero distance for pathfinding
        for (const nodeKey of networkNodes) {
            if (unvisited.has(nodeKey)) {
                distances.set(nodeKey, 0);
            }
        }

        let iterations = 0;
        while (unvisited.size > 0) {
            iterations++;

            // Find unvisited point with minimum distance
            let currentKey: string | null = null;
            let minDistance = Infinity;
            
            for (const key of unvisited) {
                const distance = distances.get(key);
                if (distance !== undefined && distance < minDistance) {
                    minDistance = distance;
                    currentKey = key;
                }
            }

            if (!currentKey || minDistance === Infinity) {
                break;
            }

            // Get current point from key
            const [row, col] = currentKey.split(',').map(Number);
            const currentPoint = this.gridPoints[row][col];

            // If we've reached the target, build and return the path
            if (row === targetPoint.row && col === targetPoint.col) {
                const path: GridPoint[] = [];
                let current: GridPoint | null = targetPoint;
                
                // Check if total cost would exceed budget or player's money
                const totalCost = distances.get(getPointKey(targetPoint)) || 0;
                
                // Use our helper method to check against both budget and money
                if (!this.isValidCost(totalCost)) {
                    return null;
                }

                // Reconstruct the path backwards from the target
                while (current !== null) {
                    path.unshift(current);
                    current = previous.get(getPointKey(current)) || null;
                    
                    // If we've reached a network node, we're done - no need to go back to original click
                    if (current && networkNodes.has(getPointKey(current))) {
                        path.unshift(current); // Include the network node in the path
                        break;
                    }
                }

                // Defensive check: if any node in the path is water, return null
                if (path.some(p => p.terrain === TerrainType.Water)) {
                    return null;
                }

                // Validate that no segment in the path overlaps with other players' tracks
                for (let i = 0; i < path.length - 1; i++) {
                    if (this.isSegmentInAnyOtherNetwork(path[i], path[i + 1], currentPlayer.id)) {
                        return null; // Path is invalid if any segment overlaps with other players' tracks
                    }
                }

                return path;
            }

            // Remove current point from unvisited
            unvisited.delete(currentKey);

            // Get potential neighbors using isAdjacent method to ensure proper hex grid adjacency
            const potentialNeighbors: GridPoint[] = [];
            
            // Check in all possible directions
            // Check same row (left and right)
            if (currentPoint.col > 0) {
                const left = this.gridPoints[currentPoint.row][currentPoint.col - 1];
                if (left && left.terrain !== TerrainType.Water && this.isAdjacent(currentPoint, left)) {
                    potentialNeighbors.push(left);
                }
            }
            if (currentPoint.col < this.gridPoints[currentPoint.row].length - 1) {
                const right = this.gridPoints[currentPoint.row][currentPoint.col + 1];
                if (right && right.terrain !== TerrainType.Water && this.isAdjacent(currentPoint, right)) {
                    potentialNeighbors.push(right);
                }
            }
            
            // Check row above if it exists
            if (currentPoint.row > 0) {
                // Check all columns in the row above that could potentially be adjacent
                for (let c = Math.max(0, currentPoint.col - 1); c <= Math.min(this.gridPoints[currentPoint.row - 1].length - 1, currentPoint.col + 1); c++) {
                    const upper = this.gridPoints[currentPoint.row - 1][c];
                    if (upper && upper.terrain !== TerrainType.Water && this.isAdjacent(currentPoint, upper)) {
                        potentialNeighbors.push(upper);
                    }
                }
            }
            
            // Check row below if it exists
            if (currentPoint.row < this.gridPoints.length - 1) {
                // Check all columns in the row below that could potentially be adjacent
                for (let c = Math.max(0, currentPoint.col - 1); c <= Math.min(this.gridPoints[currentPoint.row + 1].length - 1, currentPoint.col + 1); c++) {
                    const lower = this.gridPoints[currentPoint.row + 1][c];
                    if (lower && lower.terrain !== TerrainType.Water && this.isAdjacent(currentPoint, lower)) {
                        potentialNeighbors.push(lower);
                    }
                }
            }

            // Process neighbors
            for (const neighbor of potentialNeighbors) {
                const neighborKey = getPointKey(neighbor);
                if (!unvisited.has(neighborKey)) continue;
                
                // Skip this neighbor if the segment exists in any player's network (including current player)
                // EXCEPT if the current point is part of the network - then we allow travel via existing tracks
                const isCurrentInNetwork = networkNodes.has(currentKey);
                const isNeighborInNetwork = networkNodes.has(neighborKey);
                
                // Skip if the segment exists in any other player's network
                if (this.isSegmentInAnyOtherNetwork(currentPoint, neighbor, currentPlayer.id)) {
                    continue;
                }

                // Prevent direct connections between ferry points
                if (currentPoint.terrain === TerrainType.FerryPort && neighbor.terrain === TerrainType.FerryPort) {
                    // Only allow connection if they are part of the same ferry connection
                    const currentFerry = currentPoint.ferryConnection;
                    const neighborFerry = neighbor.ferryConnection;
                    if (!currentFerry || !neighborFerry || currentFerry !== neighborFerry) {
                        continue;
                    }
                }
                
                // Calculate the cost for a segment
                // If both points are in the network, or there's an existing segment between them, cost is 0
                let segmentCost = 0;
                if (!(isCurrentInNetwork && isNeighborInNetwork) && 
                    !this.isSegmentInNetwork(currentPoint, neighbor, playerTrackState)) {
                    segmentCost = this.calculateTrackCost(currentPoint, neighbor);
                }
                
                const newDistance = minDistance + segmentCost;

                // Update distance if new path is shorter
                const currentNeighborDistance = distances.get(neighborKey) || Infinity;
                if (newDistance < currentNeighborDistance) {
                    distances.set(neighborKey, newDistance);
                    previous.set(neighborKey, currentPoint);
                }
            }
        }

        return null;
    }

    private findClosestValidPoint(point: GridPoint): GridPoint | null {
        let closestPoint: GridPoint | null = null;
        let minDistance = Infinity;
        const MAX_PREVIEW_DISTANCE = 6;  // Match the preview distance

        for (const validPoint of this.validConnectionPoints) {
            // Calculate row and column differences
            const rowDiff = Math.abs(validPoint.row - point.row);
            const colDiff = Math.abs(validPoint.col - point.col);
            
            // Check if point is within max preview distance
            if (rowDiff <= MAX_PREVIEW_DISTANCE && colDiff <= MAX_PREVIEW_DISTANCE) {
                // Use Manhattan distance for consistency
                const distance = rowDiff + colDiff;
                if (distance < minDistance) {
                    minDistance = distance;
                    closestPoint = validPoint;
                }
            }
        }

        return closestPoint;
    }

    private isAdjacent(point1: GridPoint, point2: GridPoint): boolean {
        // Prevent null/undefined points
        if (!point1 || !point2) {
            return false;
        }

        // Calculate differences
        const rowDiff = point2.row - point1.row;  // Use directed difference
        const colDiff = point2.col - point1.col;  // Use directed difference

        // Same row adjacency - must be consecutive columns
        if (rowDiff === 0) {
            const isAdjacent = Math.abs(colDiff) === 1;
            return isAdjacent;
        }

        // Must be adjacent rows
        if (Math.abs(rowDiff) !== 1) {
            return false;
        }

        // For hex grid:
        // Even rows can connect to: (row+1, col) and (row+1, col-1)
        // Odd rows can connect to: (row+1, col) and (row+1, col+1)
        const isFromOddRow = point1.row % 2 === 1;

        let isAdjacent: boolean;
        if (rowDiff === 1) {  // Moving down
            if (isFromOddRow) {
                isAdjacent = colDiff === 0 || colDiff === 1;
            } else {
                isAdjacent = colDiff === 0 || colDiff === -1;
            }
        } else {  // Moving up (rowDiff === -1)
            const isToOddRow = point2.row % 2 === 1;
            if (isToOddRow) {
                isAdjacent = colDiff === 0 || colDiff === -1;
            } else {
                isAdjacent = colDiff === 0 || colDiff === 1;
            }
        }

        return isAdjacent;
    }

    private calculateTrackCost(from: GridPoint, to: GridPoint): number {
        // Get the base cost from the terrain type
        let cost = this.TERRAIN_COSTS[to.terrain];

        // Special handling for major city connections:
        // 1. First connection TO a major city or its outpost costs exactly 5 ECU
        // 2. Connections FROM a major city or its outpost use the destination's terrain cost
        // 3. Subsequent connections TO a major city or its outpost use the terrain cost
        const isToMajorCity = to.city?.type === TerrainType.MajorCity || this.isConnectedPointOfMajorCity(to);
        const isFromMajorCity = from.city?.type === TerrainType.MajorCity || this.isConnectedPointOfMajorCity(from);

        if (isToMajorCity && !isFromMajorCity) {
            // Get current player's track state
            const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
            const playerTrackState = this.playerTracks.get(currentPlayer.id);
            
            // Check if this is the first connection to this major city or its outpost
            const isFirstConnection = !playerTrackState?.segments.some(segment => 
                (segment.from.row === to.row && segment.from.col === to.col) ||
                (segment.to.row === to.row && segment.to.col === to.col)
            ) && !this.currentSegments.some(segment =>
                (segment.from.row === to.row && segment.from.col === to.col) ||
                (segment.to.row === to.row && segment.to.col === to.col)
            );
            
            if (isFirstConnection) {
                // First connection to major city or its outpost is exactly 5 ECU
                cost = 5;
            }
        }

        // Handle ferry port costs
        if (to.terrain === TerrainType.FerryPort && to.ferryConnection) {
            const ferryConnection = to.ferryConnection;
            const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
            const playerTrackState = this.playerTracks.get(currentPlayer.id);

            // Create a Set of points that are connected to either end of the ferry
            const connectedPoints = new Set<string>();
            
            // Helper function to add points from segments to the Set
            const addPointsFromSegments = (segments: TrackSegment[]) => {
                segments.forEach(segment => {
                    connectedPoints.add(`${segment.from.row},${segment.from.col}`);
                    connectedPoints.add(`${segment.to.row},${segment.to.col}`);
                });
            };

            // Add points from existing segments
            if (playerTrackState) {
                addPointsFromSegments(playerTrackState.segments);
            }
            
            // Add points from current segments being built
            addPointsFromSegments(this.currentSegments);

            // Create Set of ferry connection points
            const ferryPoints = new Set([
                `${ferryConnection.connections[0].row},${ferryConnection.connections[0].col}`,
                `${ferryConnection.connections[1].row},${ferryConnection.connections[1].col}`
            ]);

            // Check if any ferry points are already connected
            const isFirstConnection = !Array.from(ferryPoints).some(point => connectedPoints.has(point));

            if (isFirstConnection) {
                // First player to build to either point in the ferry connection pays the full ferry cost
                cost = ferryConnection.cost;
            } else {
                // Subsequent players or building to the other end costs nothing
                cost = 0;
            }
        }
        
        // Add a very small additional cost for diagonal movement to prefer straight paths when costs are equal
        // This ensures the algorithm prefers horizontal/vertical paths when multiple paths have the same terrain cost
        if (from.row !== to.row) {
            cost += 0.01;  // Very small penalty for changing rows
        }

        return cost;
    }

    private isSegmentInAnyOtherNetwork(point1: GridPoint, point2: GridPoint, currentPlayerId: string): boolean {
        // Check all player networks except the current player
        for (const [playerId, trackState] of this.playerTracks.entries()) {
            if (playerId !== currentPlayerId) {
                // Check if segment exists in this player's network
                if (trackState.segments.some(segment => 
                    (segment.from.row === point1.row && segment.from.col === point1.col &&
                     segment.to.row === point2.row && segment.to.col === point2.col) ||
                    (segment.from.row === point2.row && segment.from.col === point2.col &&
                     segment.to.row === point1.row && segment.to.col === point1.col)
                )) {
                    return true;
                }
            }
        }
        return false;
    }

    private isSegmentInNetwork(point1: GridPoint, point2: GridPoint, trackState?: PlayerTrackState): boolean {
        if (!trackState) return false;
        
        // First check if the segment exists in any other player's network
        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        if (this.isSegmentInAnyOtherNetwork(point1, point2, currentPlayer.id)) {
            return true;
        }
        
        // Check both directions since track segments are bidirectional
        return trackState.segments.some(segment => 
            // Check if segment matches in either direction
            ((segment.from.row === point1.row && segment.from.col === point1.col &&
              segment.to.row === point2.row && segment.to.col === point2.col) ||
             (segment.from.row === point2.row && segment.from.col === point2.col &&
              segment.to.row === point1.row && segment.to.col === point1.col))
        ) || this.currentSegments.some(segment =>
            // Also check current segments being built
            ((segment.from.row === point1.row && segment.from.col === point1.col &&
              segment.to.row === point2.row && segment.to.col === point2.col) ||
             (segment.from.row === point2.row && segment.from.col === point2.col &&
              segment.to.row === point1.row && segment.to.col === point1.col))
        );
    }
    
    private isPointConnectedToNetwork(point: GridPoint, trackState?: PlayerTrackState): boolean {
        if (!trackState) return false;

        // First check if the point is directly part of any existing segment
        const isDirectlyConnected = trackState.segments.some(segment => 
            (segment.from.row === point.row && segment.from.col === point.col) ||
            (segment.to.row === point.row && segment.to.col === point.col)
        );

        if (isDirectlyConnected) {
            return true;
        }

        // If we're currently building track, also check if the point is connected
        // to any of our current segments
        return this.currentSegments.some(segment =>
            (segment.from.row === point.row && segment.from.col === point.col) ||
            (segment.to.row === point.row && segment.to.col === point.col)
        );
    }

    private updateValidConnectionPoints(): void {
        this.validConnectionPoints.clear();
        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        const playerTrackState = this.playerTracks.get(currentPlayer.id);

        // Add all major cities and points connected to the network
        for (let r = 0; r < this.gridPoints.length; r++) {
            if (!this.gridPoints[r]) continue;
            
            for (let c = 0; c < this.gridPoints[r].length; c++) {
                const point = this.gridPoints[r][c];
                if (!point || point.terrain === TerrainType.Water) continue;
                
                const isMajorCity = point.city?.type === TerrainType.MajorCity;
                const isConnectedToNetwork = this.isPointConnectedToNetwork(point, playerTrackState);
                
                if (isMajorCity || isConnectedToNetwork) {
                    this.validConnectionPoints.add(point);
                }
            }
        }
    }

    private drawTrackSegment(segment: TrackSegment): void {
        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        const color = parseInt(currentPlayer.color.replace('#', '0x'));

        this.drawingGraphics.lineStyle(3, color, 1);
        this.drawingGraphics.beginPath();
        this.drawingGraphics.moveTo(segment.from.x, segment.from.y);
        this.drawingGraphics.lineTo(segment.to.x, segment.to.y);
        this.drawingGraphics.strokePath();
    }

    // Method to update grid points after initialization
    public updateGridPoints(gridPoints: GridPoint[][]): void {
        this.gridPoints = gridPoints;
    }
    
    // Helper method to update cost display to show only committed costs
    private updateCostDisplayToCommitted(): void {
        if (!this.isDrawingMode || !this.onCostUpdateCallback) {
            return;
        }
        
        // Only update if we have a valid preview path
        if (this.previewPath.length === 0) {
            return;
        }
        
        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        const playerTrackState = this.playerTracks.get(currentPlayer.id);
        const previousSessionsCost = playerTrackState ? playerTrackState.turnBuildCost : 0;
        const totalCommittedCost = previousSessionsCost + this.turnBuildCost;
        
        // Only call the callback if the cost has actually changed
        if (this.lastDisplayedCost !== totalCommittedCost) {
            this.lastDisplayedCost = totalCommittedCost;
            this.onCostUpdateCallback(totalCommittedCost);
        }
    }

    // Add this new helper method
    private isConnectedPointOfMajorCity(point: GridPoint): boolean {
        // Check all points in the grid for major cities
        for (let r = 0; r < this.gridPoints.length; r++) {
            if (!this.gridPoints[r]) continue;
            
            for (let c = 0; c < this.gridPoints[r].length; c++) {
                const gridPoint = this.gridPoints[r][c];
                if (!gridPoint?.city || gridPoint.city.type !== TerrainType.MajorCity) continue;
                
                // Check if the point is one of the connected points for this major city
                if (gridPoint.city.connectedPoints?.some(cp => 
                    cp.row === point.row && cp.col === point.col
                )) {
                    return true;
                }
            }
        }
        return false;
    }

    // Add cleanup method
    public cleanup(): void {
        if (this.updateEventHandler) {
            this.scene.events.off('update', this.updateEventHandler);
            this.updateEventHandler = null;
        }
        
        // Clear any pending hover timer
        if (this.hoverThrottleTimer !== null) {
            window.clearTimeout(this.hoverThrottleTimer);
            this.hoverThrottleTimer = null;
        }
        
        // Clear any pending cost updates
        this.costUpdateQueue = null;
    }

    // Add destroy method to clean up Phaser resources
    public destroy(): void {
        // Call cleanup first to handle event listeners and timers
        this.cleanup();
        
        // Clean up Phaser graphics objects
        if (this.drawingGraphics) {
            this.drawingGraphics.destroy();
        }
        if (this.previewGraphics) {
            this.previewGraphics.destroy();
        }
        
        // Clear all caches and state
        this.networkNodesCache.clear();
        this.pathCache.clear();
        this.validConnectionPoints.clear();
        this.playerTracks.clear();
        this.currentSegments = [];
        this.previewPath = [];
        this.lastClickedPoint = null;
        this.lastHoverPoint = null;
        this.pendingHoverPoint = null;
    }
}