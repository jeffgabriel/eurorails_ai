import 'phaser';
import { GameState } from '../../shared/types/GameTypes';

export interface CameraState {
    zoom: number;
    scrollX: number;
    scrollY: number;
}

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
    
    constructor(scene: Phaser.Scene, mapWidth: number, mapHeight: number, gameState: GameState) {
        this.scene = scene;
        this.camera = scene.cameras.main;
        this.mapWidth = mapWidth;
        this.mapHeight = mapHeight;
        this.gameState = gameState;
    }

    public setupCamera(): void {
        const { mapWidth, mapHeight } = this;
        const GRID_MARGIN = 100; // Same as in MapRenderer
        
        // Set up main camera with extended bounds to allow for proper scrolling
        this.camera.setBounds(
            -GRID_MARGIN, 
            -GRID_MARGIN, 
            mapWidth + (GRID_MARGIN * 2), 
            mapHeight + (GRID_MARGIN * 2)
        );
        
        // If we have a saved camera state, apply it
        if (this.gameState.cameraState) {
            this.camera.setZoom(this.gameState.cameraState.zoom);
            this.camera.scrollX = this.gameState.cameraState.scrollX;
            this.camera.scrollY = this.gameState.cameraState.scrollY;
        } else {
            // Center the camera on the map
            this.camera.centerOn(mapWidth / 2, mapHeight / 2);
            
            // Set initial zoom to fit the board better, accounting for the player hand area
            const initialZoom = Math.min(
                (this.scene.scale.width - 100) / mapWidth,
                (this.scene.scale.height - 300) / mapHeight  // Leave space for player hand
            );
            this.camera.setZoom(initialZoom);

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
                    this.camera.zoom = Math.max(minZoom, zoom - 0.1);
                } else {
                    this.camera.zoom = Math.min(maxZoom, zoom + 0.1);
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
        const currentState: CameraState = {
            zoom: this.camera.zoom,
            scrollX: this.camera.scrollX,
            scrollY: this.camera.scrollY
        };
        
        // Update local state
        this.gameState.cameraState = currentState;

        try {
            // Save to database
            const response = await fetch('/api/game/updateCameraState', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    gameId: this.gameState.id,
                    cameraState: currentState
                })
            });

            if (!response.ok) {
                console.error('Failed to save camera state:', await response.text());
            }
        } catch (error) {
            console.error('Error saving camera state:', error);
        }
    }

    public setCameraIgnoreItems(items: Phaser.GameObjects.GameObject[]): void {
        this.camera.ignore(items);
    }
}