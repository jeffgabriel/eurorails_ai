import 'phaser';
import { GameState, CameraState } from '../../shared/types/GameTypes';
import { config } from '../config/apiConfig';

export class CameraController {
    private scene: Phaser.Scene;
    private camera: Phaser.Cameras.Scene2D.Camera;
    private mapWidth: number;
    private mapHeight: number;
    private isDragging: boolean = false;
    private lastDragTime: number = 0;
    private lastPointerPosition: { x: number, y: number } = { x: 0, y: 0 };
    private isMouseDown: boolean = false;
    private gameState: GameState;
    private pendingRender: boolean = false;
    private localPlayerId: string | null = null;
    private readonly ZOOM_STEP: number = 0.05;
    
    constructor(scene: Phaser.Scene, mapWidth: number, mapHeight: number, gameState: GameState) {
        this.scene = scene;
        this.camera = scene.cameras.main;
        this.mapWidth = mapWidth;
        this.mapHeight = mapHeight;
        this.gameState = gameState;
    }

    /**
     * Set the local player ID for per-player camera state management
     */
    public setLocalPlayerId(playerId: string | null): void {
        this.localPlayerId = playerId;
    }

    /**
     * Get the local player from gameState
     */
    private getLocalPlayer() {
        if (!this.localPlayerId || !this.gameState.players) {
            return null;
        }
        return this.gameState.players.find(p => p.id === this.localPlayerId) || null;
    }

    public setupCamera(): void {
        const { mapWidth, mapHeight } = this;
        const GRID_MARGIN = 250; // Increased margin for more panning room
        
        // Set up main camera with extended bounds to allow for proper scrolling
        this.camera.setBounds(
            -GRID_MARGIN, 
            -GRID_MARGIN, 
            mapWidth + (GRID_MARGIN * 2), 
            mapHeight + (GRID_MARGIN * 2)
        );
        
        // Try to load camera state from local player first
        const localPlayer = this.getLocalPlayer();
        if (localPlayer?.cameraState) {
            // Use local player's saved camera state
            this.camera.setZoom(localPlayer.cameraState.zoom);
            this.camera.scrollX = localPlayer.cameraState.scrollX;
            this.camera.scrollY = localPlayer.cameraState.scrollY;
        } else if (this.gameState.cameraState) {
            // Fallback to deprecated global camera state (for backwards compatibility)
            this.camera.setZoom(this.gameState.cameraState.zoom);
            this.camera.scrollX = this.gameState.cameraState.scrollX;
            this.camera.scrollY = this.gameState.cameraState.scrollY;
        } else {
            // Use predefined initial camera settings for better default view
            const initialSettings = {
                zoom: 1.0561194029850745,
                scrollX: 779.2424871482747,
                scrollY: 584.8135343081639
            };
            
            this.camera.setZoom(initialSettings.zoom);
            this.camera.scrollX = initialSettings.scrollX;
            this.camera.scrollY = initialSettings.scrollY;

            // Save initial camera state
            this.saveCameraState();
        }

        this.setupInputHandlers();
    }

    private setupInputHandlers(): void {
        // Handle pointer down event
        this.scene.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
            this.isMouseDown = true;
            this.isDragging = false;
            this.lastPointerPosition = { x: pointer.x, y: pointer.y };
            this.lastDragTime = Date.now();
        });

        // Handle pointer move for camera panning
        this.scene.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
            if (!this.isMouseDown) return;
            
            const now = Date.now();
            const deltaX = pointer.x - this.lastPointerPosition.x;
            const deltaY = pointer.y - this.lastPointerPosition.y;
            
            // Only start dragging if we've moved a significant amount
            if (!this.isDragging && (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5)) {
                this.isDragging = true;
            }
            
            // If we're dragging, handle the camera movement
            if (this.isDragging && now - this.lastDragTime >= 32) {
                const newScrollX = this.camera.scrollX - (deltaX / this.camera.zoom);
                const newScrollY = this.camera.scrollY - (deltaY / this.camera.zoom);
                
                const maxScrollY = this.mapHeight - ((this.camera.height - 200) / this.camera.zoom);
                
                this.camera.scrollX = newScrollX;
                this.camera.scrollY = Math.min(maxScrollY, Math.max(0, newScrollY));
                
                this.lastPointerPosition = { x: pointer.x, y: pointer.y };
                this.lastDragTime = now;
                this.requestRender();

                // Save camera state after drag
                this.saveCameraState();
            }
        });

        // Handle pointer up event
        this.scene.input.on('pointerup', () => {
            this.isMouseDown = false;
            this.isDragging = false;
            this.requestRender();
        });

        // Handle edge case where mouse up happens outside the window
        this.scene.game.events.on('blur', () => {
            this.isMouseDown = false;
            this.isDragging = false;
        });

        // Add zoom controls with adjusted limits and throttling
        let lastWheelTime = 0;
        this.scene.input.on('wheel', (pointer: Phaser.Input.Pointer, gameObjects: any, deltaX: number, deltaY: number) => {
            const now = Date.now();
            // Throttle zoom updates to every 32ms
            if (now - lastWheelTime >= 32) {
                const zoom = this.camera.zoom;
                const minZoom = Math.min(
                    (this.camera.width - 100) / this.mapWidth,
                    (this.camera.height - 300) / this.mapHeight
                ) * 0.8;
                const maxZoom = 2.0;
                
                if (deltaY > 0) {
                    this.camera.zoom = Math.max(minZoom, zoom - this.ZOOM_STEP);
                } else {
                    this.camera.zoom = Math.min(maxZoom, zoom + this.ZOOM_STEP);
                }
                
                const maxScrollY = this.mapHeight - ((this.camera.height - 200) / this.camera.zoom);
                this.camera.scrollY = Math.min(maxScrollY, this.camera.scrollY);
                
                lastWheelTime = now;
                this.requestRender();

                // Save camera state after zoom
                this.saveCameraState();
            }
        });
    }

    private requestRender(): void {
        if (!this.pendingRender) {
            this.pendingRender = true;
            requestAnimationFrame(() => {
                this.camera.dirty = true;
                this.pendingRender = false;
            });
        }
    }

    public async saveCameraState(): Promise<void> {
        if (!this.localPlayerId) {
            console.warn('Cannot save camera state: no local player ID set');
            return;
        }

        const currentState: CameraState = {
            zoom: this.camera.zoom,
            scrollX: this.camera.scrollX,
            scrollY: this.camera.scrollY
        };
        
        // Update local player's camera state in gameState
        const localPlayer = this.getLocalPlayer();
        if (localPlayer) {
            localPlayer.cameraState = currentState;
        }

        try {
            // Use authenticated fetch with automatic token refresh
            const { authenticatedFetch } = await import('../services/authenticatedFetch');
            
            // Save to database with playerId
            const response = await authenticatedFetch(`${config.apiBaseUrl}/api/game/updateCameraState`, {
                method: 'POST',
                body: JSON.stringify({
                    gameId: this.gameState.id,
                    playerId: this.localPlayerId,
                    cameraState: currentState
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error('Failed to save camera state:', errorText);
            }
        } catch (error) {
            console.error('Error saving camera state:', error);
        }
    }

    public setCameraIgnoreItems(items: Phaser.GameObjects.GameObject[]): void {
        this.camera.ignore(items);
    }
}