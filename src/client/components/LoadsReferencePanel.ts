import Phaser from "phaser";
import { UI_FONT_FAMILY } from "../config/uiFont";
import { GameState } from "../../shared/types/GameTypes";
import {
  transformToCityData,
  ResourceTableEntry,
  CityTableEntry,
} from "../utils/loadDataTransformer";
import { api } from "../lobby/shared/api";

type LoadsReferencePage = {
  key: string;
  label: string;
  type?: "image" | "cards" | "resource" | "city"; // "image" uses texture key, "cards" renders dynamic content, "resource"/"city" are interactive tables
};

export class LoadsReferencePanel {
  private readonly scene: Phaser.Scene;
  private readonly pages: LoadsReferencePage[];
  private gameState: GameState | null = null;

  private root!: Phaser.GameObjects.Container;
  private background!: Phaser.GameObjects.Rectangle;
  private handleContainer!: Phaser.GameObjects.Container;
  private handleBg!: Phaser.GameObjects.Rectangle;
  private handleText!: Phaser.GameObjects.Text;
  private image!: Phaser.GameObjects.Image;
  private cardsContainer!: Phaser.GameObjects.Container; // For dynamic cards content
  private tabContainers: Phaser.GameObjects.Container[] = [];
  private tabHitAreas: Phaser.GameObjects.Rectangle[] = [];
  private tabLabels: Phaser.GameObjects.Text[] = [];
  private tabActiveIndicators: Phaser.GameObjects.Rectangle[] = [];

  private isOpen = false;
  private activePageIndex = 0;

  private panelWidth = 0;
  private panelHeight = 0;
  private readonly handleWidth = 34;
  private handleHeight = 160;

  // Resource/City data for interactive tables
  private resourceData: ResourceTableEntry[] = [];
  private cityData: CityTableEntry[] = [];
  private filteredResources: ResourceTableEntry[] = [];
  private filteredCities: CityTableEntry[] = [];

  // RexUI components for interactive tables
  private resourceScrollPanel: any = null;
  private cityScrollPanel: any = null;
  private resourceGridContainer!: Phaser.GameObjects.Container;
  private cityGridContainer!: Phaser.GameObjects.Container;
  private resourceGridHitArea: Phaser.GameObjects.Rectangle | null = null;
  private cityGridHitArea: Phaser.GameObjects.Rectangle | null = null;

  // Tooltip for resource cell click
  private tooltipContainer: Phaser.GameObjects.Container | null = null;
  private tooltipDismissTimer: Phaser.Time.TimerEvent | null = null;

  // Search input for filtering
  private searchInput: HTMLInputElement | null = null;
  private noResultsText: Phaser.GameObjects.Text | null = null;

  // Mask to clip grid content to panel bounds
  private contentMaskGraphics: Phaser.GameObjects.Graphics | null = null;
  private contentMask: Phaser.Display.Masks.GeometryMask | null = null;

  // Scrollbar state
  private scrollOffset: number = 0;
  private maxScrollOffset: number = 0;
  private contentAreaHeight: number = 0;
  private scrollbarTrack: Phaser.GameObjects.Rectangle | null = null;
  private scrollbarThumb: Phaser.GameObjects.Rectangle | null = null;
  private isDraggingThumb: boolean = false;
  private dragStartY: number = 0;
  private dragStartOffset: number = 0;

  constructor(scene: Phaser.Scene, pages: LoadsReferencePage[], gameState?: GameState) {
    this.scene = scene;
    this.pages = pages;
    this.gameState = gameState || null;
  }

  getContainer(): Phaser.GameObjects.Container {
    return this.root;
  }

  /**
   * Update game state for dynamic content (e.g., Cards tab)
   */
  setGameState(gameState: GameState): void {
    this.gameState = gameState;
    // If we're currently on the Cards tab, re-render it
    const activePage = this.pages[this.activePageIndex];
    if (activePage && activePage.type === "cards") {
      this.renderCardsContent();
    }
  }

  create(): void {
    this.root = this.scene.add.container(0, 20);
    this.root.setDepth(100_000);

    // Background + click-blocker (prevents clicks going to game underneath)
    this.background = this.scene.add.rectangle(0, 0, 10, 10, 0x101827, 0.92).setOrigin(0);
    this.background.setStrokeStyle(2, 0x334155, 1);
    this.background.setInteractive();

    // Tabs (create one for each page)
    const tabsBar = this.scene.add.container(0, 0);
    this.pages.forEach((page, idx) => {
      const tab = this.scene.add.container(0, 0);
      // Invisible click zone covering the full tab header area
      const hit = this.scene.add.rectangle(0, 0, 10, 10, 0x000000, 0.001).setOrigin(0);
      hit.setInteractive({ useHandCursor: true });
      hit.on("pointerdown", () => this.setActivePage(idx));

      const tabText = this.scene.add
        .text(0, 0, page.label, {
          color: "#e2e8f0",
          fontSize: "14px",
          fontStyle: "bold",
          fontFamily: UI_FONT_FAMILY,
        })
        .setOrigin(0, 0);

      const activeIndicator = this.scene.add.rectangle(0, 0, 10, 3, 0x60a5fa, 1).setOrigin(0);
      tab.add([hit, tabText, activeIndicator]);
      tabsBar.add(tab);

      this.tabContainers.push(tab);
      this.tabHitAreas.push(hit);
      this.tabLabels.push(tabText);
      this.tabActiveIndicators.push(activeIndicator);
    });

    // Image (for image-type pages) - use first image page as default
    const firstImagePage = this.pages.find(p => p.type === "image") || this.pages[0];
    this.image = this.scene.add.image(0, 0, firstImagePage.key).setOrigin(0.5, 0.5);
    this.image.setVisible(this.pages[this.activePageIndex].type === "image");

    // Cards container (for cards-type pages)
    this.cardsContainer = this.scene.add.container(0, 0);
    this.cardsContainer.setVisible(this.pages[this.activePageIndex].type === "cards");

    // Resource grid container (for "resource" type pages - interactive table)
    this.resourceGridContainer = this.scene.add.container(0, 0);
    this.resourceGridContainer.setVisible(this.pages[this.activePageIndex].type === "resource");

    // City grid container (for "city" type pages - interactive table)
    this.cityGridContainer = this.scene.add.container(0, 0);
    this.cityGridContainer.setVisible(this.pages[this.activePageIndex].type === "city");

    // Add invisible interactive hit areas to block wheel events from reaching the map
    // These will be sized and positioned in layout()
    this.resourceGridHitArea = this.scene.add.rectangle(0, 0, 10, 10, 0x000000, 0.001).setOrigin(0);
    this.resourceGridHitArea.setInteractive();
    this.resourceGridContainer.add(this.resourceGridHitArea);
    this.resourceGridContainer.sendToBack(this.resourceGridHitArea);

    this.cityGridHitArea = this.scene.add.rectangle(0, 0, 10, 10, 0x000000, 0.001).setOrigin(0);
    this.cityGridHitArea.setInteractive();
    this.cityGridContainer.add(this.cityGridHitArea);
    this.cityGridContainer.sendToBack(this.cityGridHitArea);

    // Create mask graphics to clip content to panel bounds
    // The mask is created in world space and positioned in layout()
    this.contentMaskGraphics = this.scene.add.graphics();
    this.contentMask = this.contentMaskGraphics.createGeometryMask();

    // Apply mask to grid containers and cards container
    this.resourceGridContainer.setMask(this.contentMask);
    this.cityGridContainer.setMask(this.contentMask);
    this.cardsContainer.setMask(this.contentMask);

    // Load resource/city data asynchronously
    this.loadResourceData();

    // Create search input (DOM overlay)
    this.createSearchInput();

    // Handle (always visible on left edge; clickable for full panel height)
    this.handleContainer = this.scene.add.container(0, 0);
    // Use a calmer slate/grey instead of bright blue
    this.handleBg = this.scene.add.rectangle(0, 0, this.handleWidth, this.handleHeight, 0x64748b, 1).setOrigin(0);
    this.handleBg.setStrokeStyle(1, 0x475569, 1);
    this.handleBg.setInteractive({ useHandCursor: true });
    this.handleBg.on("pointerdown", () => this.toggle());

    this.handleText = this.scene.add
      .text(this.handleWidth / 2, this.handleHeight / 2, "LOADS", {
        color: "#ffffff",
        fontSize: "14px",
        fontStyle: "bold",
        fontFamily: UI_FONT_FAMILY,
      })
      .setOrigin(0.5);
    this.handleText.setRotation(-Math.PI / 2);

    this.handleContainer.add([this.handleBg, this.handleText]);

    // Create scrollbar (track and thumb)
    this.scrollbarTrack = this.scene.add.rectangle(0, 0, 8, 100, 0x334155, 1).setOrigin(0);
    this.scrollbarTrack.setInteractive({ useHandCursor: true });
    this.scrollbarTrack.on("pointerdown", (pointer: Phaser.Input.Pointer) => this.onTrackClick(pointer));

    this.scrollbarThumb = this.scene.add.rectangle(0, 0, 8, 50, 0x64748b, 1).setOrigin(0);
    this.scrollbarThumb.setInteractive({ useHandCursor: true, draggable: true });

    // Thumb drag handlers
    this.scrollbarThumb.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      this.isDraggingThumb = true;
      this.dragStartY = pointer.y;
      this.dragStartOffset = this.scrollOffset;
    });

    this.scene.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (this.isDraggingThumb) {
        this.onThumbDrag(pointer);
      }
    });

    this.scene.input.on("pointerup", () => {
      this.isDraggingThumb = false;
    });

    // Mouse wheel scrolling on the content area
    this.scene.input.on("wheel", (pointer: Phaser.Input.Pointer, gameObjects: any[], deltaX: number, deltaY: number) => {
      if (this.isPointerOverContent(pointer)) {
        this.onMouseWheel(deltaY);
      }
    });

    this.root.add([
      this.background,
      tabsBar,
      this.image,
      this.cardsContainer,
      this.resourceGridContainer,
      this.cityGridContainer,
      this.scrollbarTrack,
      this.scrollbarThumb,
      this.handleContainer,
    ]);

    // Keep references for layout
    (this.root as any).__loadsTabsBar = tabsBar as Phaser.GameObjects.Container;

    this.layout();
    this.updateTabStyles();
  }

  layout(): void {
    // Early return if UI hasn't been created yet
    if (!this.root || !this.background) {
      return;
    }

    const width = this.scene.scale.width;
    const height = this.scene.scale.height;

    // Keep the visible handle out of the top-left settings area and above the player-hand bar.
    // Use slightly looser bounds when open so the reference image can scale up.
    const safeTop = this.isOpen ? 30 : 70;
    const safeBottom = this.isOpen ? 50 : 300;

    const marginY = 18;
    // Allow the panel to scale up when open; keep it slimmer when closed so
    // the always-visible handle doesn't crowd other UI.
    const shrinkPx = this.isOpen ? 0 : 75;

    const tabsPadding = 12;
    const tabHeight = 40;
    const tabGap = 8;
    const imagePaddingX = 12;
    const imagePaddingBottom = 12;
    const imageTop = tabsPadding + tabHeight + 12;

    // Constrain panel to viewport (never exceed)
    const widthFactor = this.isOpen ? 0.98 : 0.92;
    const maxPanelWidth = Math.max(360, Math.floor(width * widthFactor) - shrinkPx);
    const maxPanelHeightFromViewport = Math.floor(height - marginY * 2) - shrinkPx;
    const maxPanelHeightFromSafeBand = Math.floor(height - safeTop - safeBottom) - shrinkPx;
    const maxPanelHeight = Math.max(240, Math.min(maxPanelHeightFromViewport, maxPanelHeightFromSafeBand));

    // Determine panel size based on active page type
    const activePage = this.pages[this.activePageIndex];
    const pageType = activePage?.type || "image";

    let scaledW: number;
    let scaledH: number;

    if (pageType === "resource" || pageType === "city" || pageType === "cards") {
      // For interactive tables and cards, use fixed dimensions
      scaledW = 380;
      scaledH = 625;
    } else {
      // Determine panel size based on scaled image size (for image pages)
      const pageKey = activePage?.key || "loads-reference-page-1";
      if (this.scene.textures.exists(pageKey)) {
        this.image.setTexture(pageKey);
        const source = this.scene.textures.get(pageKey).getSourceImage() as
          | HTMLImageElement
          | HTMLCanvasElement
          | ImageBitmap;

        const srcW: number = source.width;
        const srcH: number = source.height;

        const maxImageHeight = maxPanelHeight - imageTop - imagePaddingBottom;
        const maxImageWidth = maxPanelWidth - imagePaddingX * 2;

        const scale = Math.min(1, maxImageWidth / srcW, maxImageHeight / srcH);
        scaledW = Math.floor(srcW * scale);
        scaledH = Math.floor(srcH * scale);
      } else {
        scaledW = 400;
        scaledH = 400;
      }
    }

    // Ensure panel is wide enough for all tab labels (so tabs are clickable and text fits),
    // while still keeping it "image-sized" when possible.
    const estimatedLabelWidths = this.tabLabels.map((t) => Math.ceil(t.getBounds().width));
    const minTabWidths = estimatedLabelWidths.map((w) => Math.max(100, w + 20));
    const totalTabGaps = tabGap * (this.pages.length - 1);
    // Extra breathing room so tab labels never get clipped by rounding/layout.
    const minWidthForTabs =
      tabsPadding * 2 + minTabWidths.reduce((a, b) => a + b, 0) + totalTabGaps + 40;

    this.panelWidth = Math.min(
      maxPanelWidth,
      Math.max(this.handleWidth + 20, scaledW + imagePaddingX * 2, minWidthForTabs)
    );
    this.panelHeight = Math.min(maxPanelHeight, Math.max(220, imageTop + scaledH + imagePaddingBottom));

    // Center vertically *within* the safe band so it doesn't collide with top-left controls
    // or the bottom player-hand bar.
    const availableTop = Math.max(marginY, safeTop);
    const availableBottom = Math.max(availableTop + 1, height - safeBottom);
    const availableHeight = Math.max(1, availableBottom - availableTop);
    const centeredY = Math.floor(availableTop + (availableHeight - this.panelHeight) / 2);
    const clampedY = Math.max(availableTop, Math.min(centeredY, availableBottom - this.panelHeight));
    this.root.y = clampedY;

    // Keep handle full height and always clickable
    this.handleHeight = this.panelHeight;

    // Position root based on open/closed state
    const closedX = -(this.panelWidth - this.handleWidth);
    this.root.x = this.isOpen ? 0 : closedX;

    // Background
    if (this.background) {
      this.background.width = this.panelWidth;
      this.background.height = this.panelHeight;
    }

    // Tabs
    const tabsBar: Phaser.GameObjects.Container | undefined = (this.root as any).__loadsTabsBar;
    if (!tabsBar || this.tabContainers.length === 0) {
      return; // UI not fully initialized yet
    }

    const numTabs = this.pages.length;
    const totalGapWidth = tabGap * (numTabs - 1);
    const tabWidth = Math.max(120, Math.floor((this.panelWidth - tabsPadding * 2 - totalGapWidth) / numTabs));

    tabsBar.x = tabsPadding;
    tabsBar.y = tabsPadding;

    this.pages.forEach((_, idx) => {
      const tab = this.tabContainers[idx];
      if (!tab) return;

      tab.x = idx * (tabWidth + tabGap);
      tab.y = 0;

      const hit = this.tabHitAreas[idx];
      if (hit) {
        hit.width = tabWidth;
        hit.height = tabHeight;
        // Phaser input hit areas don't automatically follow width/height mutations
        hit.setSize(tabWidth, tabHeight);
      }

      const text = this.tabLabels[idx];
      if (text) {
        text.x = 10;
        text.y = 10;
      }

      const indicator = this.tabActiveIndicators[idx];
      if (indicator) {
        indicator.width = tabWidth;
        indicator.height = 3;
        indicator.x = 0;
        indicator.y = tabHeight - 3;
      }
    });

    // Handle is anchored so it remains visible at x=0 when closed.
    if (this.handleContainer) {
      this.handleContainer.x = this.panelWidth - this.handleWidth;
      this.handleContainer.y = 0;
    }
    if (this.handleBg) {
      this.handleBg.height = this.handleHeight;
      this.handleBg.setSize(this.handleWidth, this.handleHeight);
    }
    if (this.handleText) {
      this.handleText.x = this.handleWidth / 2;
      this.handleText.y = Math.floor(this.handleHeight / 2);
    }

    // Content area below tabs - show only the active content type
    const contentPaddingX = imagePaddingX;
    const contentTop = imageTop;
    const scrollbarWidth = 12;
    const contentWidth = this.panelWidth - contentPaddingX * 2 - this.handleWidth - scrollbarWidth;
    const contentHeight = this.panelHeight - contentTop - imagePaddingBottom;

    // Position scrollbar (right side of content area, before handle)
    if (this.scrollbarTrack) {
      this.scrollbarTrack.x = this.panelWidth - this.handleWidth - scrollbarWidth;
      this.scrollbarTrack.y = contentTop;
      this.scrollbarTrack.height = contentHeight;
      this.scrollbarTrack.width = 8;
    }
    if (this.scrollbarThumb) {
      this.scrollbarThumb.x = this.panelWidth - this.handleWidth - scrollbarWidth;
      this.scrollbarThumb.width = 8;
    }

    // Update mask to clip content to panel bounds (world coordinates)
    if (this.contentMaskGraphics) {
      this.contentMaskGraphics.clear();
      // Draw filled rectangle at the content area position in world space
      const maskX = this.root.x + contentPaddingX;
      const maskY = this.root.y + contentTop;
      this.contentMaskGraphics.fillStyle(0xffffff);
      this.contentMaskGraphics.fillRect(maskX, maskY, contentWidth, contentHeight);
    }

    // Hide all content containers and scrollbar first
    this.image.setVisible(false);
    this.cardsContainer.setVisible(false);
    this.resourceGridContainer.setVisible(false);
    this.cityGridContainer.setVisible(false);
    if (this.scrollbarTrack) this.scrollbarTrack.setVisible(false);
    if (this.scrollbarThumb) this.scrollbarThumb.setVisible(false);

    if (pageType === "cards") {
      // Show cards container
      this.cardsContainer.setVisible(true);
      this.cardsContainer.x = contentPaddingX;
      this.cardsContainer.y = contentTop - this.scrollOffset;
      this.renderCardsContent();

      // Calculate cards content height (approximate based on rendered content)
      const cardsContentHeight = this.cardsContainer.getBounds().height || contentHeight;
      this.updateScrollbar(cardsContentHeight, contentHeight);
    } else if (pageType === "resource") {
      // Show resource grid
      this.resourceGridContainer.setVisible(true);
      this.resourceGridContainer.x = contentPaddingX;
      this.resourceGridContainer.y = contentTop;

      // Size the hit area to cover the content area
      if (this.resourceGridHitArea) {
        this.resourceGridHitArea.setSize(contentWidth, contentHeight);
        this.resourceGridHitArea.width = contentWidth;
        this.resourceGridHitArea.height = contentHeight;
      }

      // Calculate content height and update scrollbar
      // Add buffer to ensure last row is fully visible when scrolled
      const scrollBuffer = 80;
      const gridHeight = (this.resourceScrollPanel?.height || 0) + scrollBuffer;
      this.updateScrollbar(gridHeight, contentHeight);
      this.updateContentPosition();
    } else if (pageType === "city") {
      // Show city grid
      this.cityGridContainer.setVisible(true);
      this.cityGridContainer.x = contentPaddingX;
      this.cityGridContainer.y = contentTop;

      // Size the hit area to cover the content area
      if (this.cityGridHitArea) {
        this.cityGridHitArea.setSize(contentWidth, contentHeight);
        this.cityGridHitArea.width = contentWidth;
        this.cityGridHitArea.height = contentHeight;
      }

      // Calculate content height and update scrollbar
      // Add buffer to ensure last row is fully visible when scrolled
      const scrollBuffer = 80;
      const gridHeight = (this.cityScrollPanel?.height || 0) + scrollBuffer;
      this.updateScrollbar(gridHeight, contentHeight);
      this.updateContentPosition();
    } else {
      // Show image (default for "image" type)
      const pageKey = activePage?.key || "loads-reference-page-1";
      if (this.scene.textures.exists(pageKey)) {
        this.image.setVisible(true);
        this.image.setTexture(pageKey);

        const source = this.scene.textures.get(pageKey).getSourceImage() as
          | HTMLImageElement
          | HTMLCanvasElement
          | ImageBitmap;
        const srcW: number = source.width;
        const srcH: number = source.height;

        const maxImageWidthForPanel = this.panelWidth - contentPaddingX * 2;
        const maxImageHeightForPanel = this.panelHeight - contentTop - imagePaddingBottom;
        const scaleForPanel = Math.min(1, maxImageWidthForPanel / srcW, maxImageHeightForPanel / srcH);
        this.image.setScale(scaleForPanel);
        this.image.x = Math.floor(this.panelWidth / 2);
        this.image.y = Math.floor(contentTop + maxImageHeightForPanel / 2);
      }
    }

    // Position the search input
    this.positionSearchInput();
  }

  /**
   * Render the Cards tab content showing all players' demand cards
   */
  private renderCardsContent(): void {
    // Clear existing cards content
    this.cardsContainer.removeAll(true);
    
    if (!this.gameState || !this.gameState.players || this.gameState.players.length === 0) {
      const noDataText = this.scene.add.text(
        10, 10,
        "No player data available",
        { fontSize: "14px", color: "#94a3b8", fontFamily: UI_FONT_FAMILY }
      );
      this.cardsContainer.add(noDataText);
      return;
    }
    
    const contentPadding = 12;
    const maxContentWidth = this.panelWidth - contentPadding * 2 - 24; // Leave room for padding
    let yOffset = 0;
    
    // Render each player's cards
    this.gameState.players.forEach((player, playerIndex) => {
      // Player name header
      const playerNameText = this.scene.add.text(
        0, yOffset,
        `${player.name}`,
        { 
          fontSize: "16px", 
          fontStyle: "bold",
          color: player.color || "#ffffff", 
          fontFamily: UI_FONT_FAMILY 
        }
      );
      this.cardsContainer.add(playerNameText);
      yOffset += 24;
      
      // Render cards
      const cards = player.hand || [];
      if (cards.length === 0) {
        const noCardsText = this.scene.add.text(
          10, yOffset,
          "(No cards)",
          { fontSize: "12px", color: "#64748b", fontFamily: UI_FONT_FAMILY, fontStyle: "italic" }
        );
        this.cardsContainer.add(noCardsText);
        yOffset += 20;
      } else {
        cards.forEach((card: any, cardIndex: number) => {
          if (!card) return;
          
          // Card header with card number
          const cardHeaderText = this.scene.add.text(
            10, yOffset,
            `Card ${cardIndex + 1}:`,
            { fontSize: "12px", color: "#94a3b8", fontFamily: UI_FONT_FAMILY, fontStyle: "bold" }
          );
          this.cardsContainer.add(cardHeaderText);
          yOffset += 16;
          
          // Each demand (city + resource + payment)
          const demands = card.demands || [];
          demands.forEach((demand: any, demandIndex: number) => {
            if (!demand) return;
            
            const demandText = this.scene.add.text(
              15, yOffset,
              `• ${demand.resource} to ${demand.city} - ECU ${demand.payment}M`,
              { fontSize: "11px", color: "#e2e8f0", fontFamily: UI_FONT_FAMILY }
            );
            this.cardsContainer.add(demandText);
            yOffset += 14;
          });
          
          yOffset += 6; // Gap between cards
        });
      }
      
      // Gap between players
      yOffset += 12;
    });
  }

  /**
   * Load resource/city data from API and transform it
   */
  private async loadResourceData(): Promise<void> {
    try {
      // Use existing API instead of fetching raw config
      const loadStates = await api.getLoadState();

      // Transform LoadState[] to ResourceTableEntry[]
      this.resourceData = loadStates.map(state => ({
        name: state.loadType,
        cities: state.cities,
        count: state.totalCount,
        iconKey: `load-${state.loadType.toLowerCase()}`
      })).sort((a, b) => a.name.localeCompare(b.name));

      // Transform to city-based view
      this.cityData = transformToCityData(this.resourceData);

      // Initialize filtered arrays with full data
      this.filteredResources = [...this.resourceData];
      this.filteredCities = [...this.cityData];

      // Create the interactive tables now that data is loaded
      this.createResourceTable();
      this.createCityTable();

      // Re-layout to position the new content
      this.layout();
    } catch (error) {
      console.error("Error loading resource data:", error);
    }
  }

  /**
   * Create the RexUI ScrollablePanel for the Resource Table (By Resource tab)
   */
  private createResourceTable(): void {
    if (this.resourceData.length === 0) return;

    const rexUI = (this.scene as any).rexUI;
    if (!rexUI) {
      console.warn("RexUI plugin not available");
      return;
    }

    // Clear existing content (preserve hit area)
    if (this.resourceGridHitArea) {
      this.resourceGridContainer.remove(this.resourceGridHitArea, false);
    }
    this.resourceGridContainer.removeAll(true);
    if (this.resourceGridHitArea) {
      this.resourceGridContainer.add(this.resourceGridHitArea);
      this.resourceGridContainer.sendToBack(this.resourceGridHitArea);
    }

    // Create grid sizer with 3 columns and add directly (no ScrollablePanel)
    const gridSizer = this.createResourceGridSizer();
    if (!gridSizer) return;

    // Layout the grid first to get its dimensions
    gridSizer.layout();

    // RexUI uses center origin - offset by half width/height to align top-left with container origin
    // Add 50px vertical offset to account for search bar
    const gridWidth = gridSizer.width;
    const gridHeight = gridSizer.height;
    const searchBarOffset = 50;
    gridSizer.setPosition(gridWidth / 2, gridHeight / 2 + searchBarOffset);

    // Store reference for later cleanup
    this.resourceScrollPanel = gridSizer;

    this.resourceGridContainer.add(gridSizer);
  }

  /**
   * Create a GridSizer containing ResourceCells (3 columns x 10 rows)
   */
  private createResourceGridSizer(): any {
    const rexUI = (this.scene as any).rexUI;
    if (!rexUI) return null;

    const columns = 3;
    const rows = Math.ceil(this.filteredResources.length / columns);

    // Use GridSizer with fixed 3 columns
    const sizer = rexUI.add.gridSizer({
      column: columns,
      row: rows,
      columnProportions: 1,
      rowProportions: 1,
      space: { column: 12, row: 12 },
    });

    // Add ResourceCell for each resource
    this.filteredResources.forEach((resource, index) => {
      const cell = this.createResourceCell(resource);
      const col = index % columns;
      const row = Math.floor(index / columns);
      sizer.add(cell, { column: col, row: row, padding: { left: 4, right: 4, top: 4, bottom: 4 } });
    });

    return sizer;
  }

  /**
   * Create a ResourceCell component for the "By Resource" tab
   * Displays resource icon in circular background + name-count text
   * @param resource - The resource data to display
   */
  private createResourceCell(resource: ResourceTableEntry): any {
    const rexUI = (this.scene as any).rexUI;

    // Fixed cell dimensions for consistent grid layout
    const cellWidth = 100;
    const cellHeight = 70;

    // Cell background with border
    const cellBg = rexUI.add.roundRectangle({
      width: cellWidth,
      height: cellHeight,
      radius: 6,
      color: 0x1e293b,
      strokeColor: 0x334155,
      strokeWidth: 1,
    });

    // Icon container: circular background + icon
    const iconSize = 24;
    const iconBgRadius = 16;

    // Create circular background for icon (white background)
    const iconBg = rexUI.add.roundRectangle({
      width: iconBgRadius * 2,
      height: iconBgRadius * 2,
      radius: iconBgRadius,
      color: 0xffffff,
    });

    // Resource icon (if texture exists)
    let icon: Phaser.GameObjects.Image | null = null;
    if (this.scene.textures.exists(resource.iconKey)) {
      icon = this.scene.add.image(0, 0, resource.iconKey).setDisplaySize(iconSize, iconSize);
    }

    // Create an OverlapSizer to properly center the icon over the background
    const iconContainer = rexUI.add.overlapSizer({
      width: iconBgRadius * 2,
      height: iconBgRadius * 2,
    });
    iconContainer.add(iconBg, { key: 'bg', align: 'center', expand: false });
    if (icon) {
      iconContainer.add(icon, { key: 'icon', align: 'center', expand: false });
    }

    // Resource name text
    const text = this.scene.add.text(0, 0, resource.name, {
      fontSize: "12px",
      color: "#e2e8f0",
      fontFamily: UI_FONT_FAMILY,
      fontStyle: "bold",
    }).setOrigin(0.5);

    // Create main cell sizer (vertical layout: icon on top, text below)
    // Use fixed size to ensure consistent cell dimensions
    const cell = rexUI.add.sizer({
      orientation: "y",
      space: { item: 6 },
      width: cellWidth,
      height: cellHeight,
    });

    cell.addBackground(cellBg);
    cell.add(iconContainer, { align: "center", padding: { top: 8 } });
    cell.add(text, { align: "center", padding: { left: 4, right: 4, bottom: 8 } });

    // Store resource data for tooltip
    (cell as any).__resourceData = resource;

    // Make cell interactive for tooltip display
    cell.setInteractive({ useHandCursor: true });
    cell.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      // Use pointer position for accurate tooltip placement (accounts for scroll)
      this.showResourceTooltip(resource, pointer.x, pointer.y);
    });

    // Hover effect
    cell.on("pointerover", () => {
      cellBg.setFillStyle(0x334155);
    });
    cell.on("pointerout", () => {
      cellBg.setFillStyle(0x1e293b);
    });

    return cell;
  }

  /**
   * Show tooltip with list of cities where resource is available
   * @param resource - The resource data
   * @param x - X position for tooltip (pointer world X)
   * @param y - Y position for tooltip (pointer world Y)
   */
  private showResourceTooltip(resource: ResourceTableEntry, x: number, y: number): void {
    // Hide any existing tooltip
    this.hideResourceTooltip();

    const rexUI = (this.scene as any).rexUI;
    if (!rexUI) return;

    // Create tooltip text content
    const cityList = resource.cities.length > 0
      ? resource.cities.join("\n")
      : "No cities available";
    const tooltipText = this.scene.add.text(0, 0, `Count: ${resource.count}\n\nAvailable in:\n${cityList}`, {
      fontSize: "12px",
      color: "#e2e8f0",
      fontFamily: UI_FONT_FAMILY,
      lineSpacing: 4,
    });

    // Calculate tooltip dimensions based on text
    const padding = 12;
    const tooltipWidth = tooltipText.width + padding * 2;
    const tooltipHeight = tooltipText.height + padding * 2;

    // Create tooltip background
    const tooltipBg = rexUI.add.roundRectangle({
      width: tooltipWidth,
      height: tooltipHeight,
      radius: 6,
      color: 0x1e293b,
      alpha: 0.95,
      strokeColor: 0x475569,
      strokeWidth: 1,
    });

    // Convert world coordinates to local coordinates relative to root container
    // Use root.x/y directly instead of getBounds() which includes scrolled content
    let localX = x - this.root.x + 20; // Offset to the right of click
    let localY = y - this.root.y;

    // Horizontal bounds check - keep tooltip within panel
    const panelWidth = this.panelWidth - this.handleWidth;
    if (localX + tooltipWidth / 2 > panelWidth - 10) {
      // Position to the left of the click instead
      localX = x - this.root.x - tooltipWidth / 2 - 20;
    }
    // Ensure doesn't go off left edge
    if (localX - tooltipWidth / 2 < 10) {
      localX = tooltipWidth / 2 + 10;
    }

    // Vertical bounds check - keep tooltip within panel
    const panelHeight = this.panelHeight;
    if (localY + tooltipHeight / 2 > panelHeight - 10) {
      // Move tooltip up so it stays within panel
      localY = panelHeight - tooltipHeight / 2 - 10;
    }
    // Ensure doesn't go off top edge
    if (localY - tooltipHeight / 2 < 60) { // Account for tabs
      localY = tooltipHeight / 2 + 60;
    }

    // Create tooltip container at adjusted local coordinates
    this.tooltipContainer = this.scene.add.container(localX, localY);
    this.tooltipContainer.setDepth(100_001);

    // Add background and text to container (centered on container position)
    this.tooltipContainer.add(tooltipBg);
    tooltipText.setPosition(-tooltipWidth / 2 + padding, -tooltipHeight / 2 + padding);
    this.tooltipContainer.add(tooltipText);

    // Add tooltip to root container
    this.root.add(this.tooltipContainer);

    // Auto-dismiss after 3 seconds
    this.tooltipDismissTimer = this.scene.time.delayedCall(3000, () => {
      this.hideResourceTooltip();
    });

    // Dismiss on click outside (click on background)
    this.background.once("pointerdown", () => {
      this.hideResourceTooltip();
    });
  }

  /**
   * Hide and destroy the resource tooltip
   */
  private hideResourceTooltip(): void {
    if (this.tooltipDismissTimer) {
      this.tooltipDismissTimer.destroy();
      this.tooltipDismissTimer = null;
    }
    if (this.tooltipContainer) {
      this.tooltipContainer.destroy(true);
      this.tooltipContainer = null;
    }
  }

  /**
   * Create the RexUI ScrollablePanel for the City Table (By City tab)
   */
  private createCityTable(): void {
    if (this.cityData.length === 0) return;

    const rexUI = (this.scene as any).rexUI;
    if (!rexUI) {
      console.warn("RexUI plugin not available");
      return;
    }

    // Clear existing content (preserve hit area)
    if (this.cityGridHitArea) {
      this.cityGridContainer.remove(this.cityGridHitArea, false);
    }
    this.cityGridContainer.removeAll(true);
    if (this.cityGridHitArea) {
      this.cityGridContainer.add(this.cityGridHitArea);
      this.cityGridContainer.sendToBack(this.cityGridHitArea);
    }

    // Create grid sizer with 3 columns
    const gridSizer = this.createCityGridSizer();
    if (!gridSizer) return;

    // Layout the grid first to get its dimensions
    gridSizer.layout();

    // RexUI uses center origin - offset by half width/height to align top-left with container origin
    // Add 50px vertical offset to account for search bar
    const gridWidth = gridSizer.width;
    const gridHeight = gridSizer.height;
    const searchBarOffset = 50;
    gridSizer.setPosition(gridWidth / 2, gridHeight / 2 + searchBarOffset);

    // Store reference for later cleanup
    this.cityScrollPanel = gridSizer;

    this.cityGridContainer.add(gridSizer);
  }

  /**
   * Create a GridSizer containing CityCells (3 columns x 18 rows)
   */
  private createCityGridSizer(): any {
    const rexUI = (this.scene as any).rexUI;
    if (!rexUI) return null;

    const columns = 3;
    const rows = Math.ceil(this.filteredCities.length / columns);

    // Use GridSizer with fixed 3 columns
    const sizer = rexUI.add.gridSizer({
      column: columns,
      row: rows,
      columnProportions: 1,
      rowProportions: 1,
      space: { column: 12, row: 12 },
    });

    // Add CityCell for each city
    this.filteredCities.forEach((city, index) => {
      const cell = this.createCityCell(city);
      const col = index % columns;
      const row = Math.floor(index / columns);
      sizer.add(cell, { column: col, row: row, padding: { left: 4, right: 4, top: 4, bottom: 4 } });
    });

    return sizer;
  }

  /**
   * Create a CityCell component for the "By City" tab
   * Displays city name + row of resource icons (up to 5 with +X indicator)
   * @param city - The city data to display
   */
  private createCityCell(city: CityTableEntry): any {
    const rexUI = (this.scene as any).rexUI;

    // Fixed cell dimensions for consistent grid layout
    const cellWidth = 100;
    const cellHeight = 60;

    // Cell background with border (white background)
    const cellBg = rexUI.add.roundRectangle({
      width: cellWidth,
      height: cellHeight,
      radius: 6,
      color: 0xffffff,
      strokeColor: 0x334155,
      strokeWidth: 1,
    });

    // City name (uppercase, bold, centered, black text)
    const nameText = this.scene.add.text(0, 0, city.name.toUpperCase(), {
      fontSize: "11px",
      color: "#1e293b",
      fontFamily: UI_FONT_FAMILY,
      fontStyle: "bold",
    }).setOrigin(0.5);

    // Resource icons row (up to 5 icons + "+X" if more)
    const maxIcons = 5;
    const iconSize = 16;
    const iconsRow = rexUI.add.sizer({
      orientation: "x",
      space: { item: 2 },
    });

    // Add resource icons (up to maxIcons)
    const resourcesToShow = city.resources.slice(0, maxIcons);
    for (const resourceName of resourcesToShow) {
      const iconKey = `load-${resourceName.toLowerCase()}`;
      if (this.scene.textures.exists(iconKey)) {
        const icon = this.scene.add.image(0, 0, iconKey).setDisplaySize(iconSize, iconSize);
        iconsRow.add(icon, { align: "center" });
      }
    }

    // Add "+X" indicator if more than 5 resources
    if (city.resources.length > maxIcons) {
      const moreText = this.scene.add.text(0, 0, `+${city.resources.length - maxIcons}`, {
        fontSize: "10px",
        color: "#64748b",
        fontFamily: UI_FONT_FAMILY,
      }).setOrigin(0.5);
      iconsRow.add(moreText, { align: "center" });
    }

    // Create main cell sizer (vertical layout: name on top, icons below)
    // Use fixed size to ensure consistent cell dimensions
    const cell = rexUI.add.sizer({
      orientation: "y",
      space: { item: 4 },
      width: cellWidth,
      height: cellHeight,
    });

    cell.addBackground(cellBg);
    cell.add(nameText, { align: "center", padding: { left: 4, right: 4, top: 8 } });
    cell.add(iconsRow, { align: "center", padding: { bottom: 8 } });

    // Store city data for camera navigation
    (cell as any).__cityData = city;

    // Make cell interactive for camera navigation
    cell.setInteractive({ useHandCursor: true });

    // Click to navigate camera to city
    cell.on("pointerdown", () => {
      this.navigateToCity(city.name);
    });

    // Hover effect (lighter grey on hover for white cells)
    cell.on("pointerover", () => {
      cellBg.setFillStyle(0xe2e8f0);
    });
    cell.on("pointerout", () => {
      cellBg.setFillStyle(0xffffff);
    });

    return cell;
  }

  /**
   * Navigate the game camera to a city's location on the map
   * @param cityName - The name of the city to navigate to
   */
  private navigateToCity(cityName: string): void {
    try {
      // Get reference to GameScene
      const gameScene = this.scene.scene.get("GameScene") as any;

      if (gameScene && typeof gameScene.centerCameraOnCity === "function") {
        // Call the existing camera navigation method
        gameScene.centerCameraOnCity(cityName);
      } else {
        console.warn(`Unable to navigate to city: ${cityName}. GameScene or centerCameraOnCity not available.`);
      }
    } catch (error) {
      console.error(`Error navigating to city ${cityName}:`, error);
    }
    // Note: Panel remains open after navigation (no close action needed)
  }

  /**
   * Create the DOM search input element for filtering
   */
  private createSearchInput(): void {
    // Create input element
    this.searchInput = document.createElement("input");
    this.searchInput.type = "text";
    this.searchInput.placeholder = "Search...";

    // Apply styling to match game UI
    this.searchInput.style.cssText = `
      position: absolute;
      width: 200px;
      padding: 6px 10px;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 4px;
      color: #e2e8f0;
      font-size: 14px;
      font-family: inherit;
      outline: none;
      z-index: 100002;
      display: none;
    `;

    // Add input event listener for filtering
    this.searchInput.addEventListener("input", (e) => {
      const query = (e.target as HTMLInputElement).value;
      this.filterContent(query);
    });

    // Focus style
    this.searchInput.addEventListener("focus", () => {
      if (this.searchInput) {
        this.searchInput.style.borderColor = "#60a5fa";
      }
    });
    this.searchInput.addEventListener("blur", () => {
      if (this.searchInput) {
        this.searchInput.style.borderColor = "#334155";
      }
    });

    // Append to document body
    document.body.appendChild(this.searchInput);
  }

  /**
   * Position the search input based on panel position
   */
  private positionSearchInput(): void {
    if (!this.searchInput) return;

    // Only show search input when panel is open and on resource/city tab
    const activePage = this.pages[this.activePageIndex];
    const isInteractiveTab = activePage?.type === "resource" || activePage?.type === "city";

    if (this.isOpen && isInteractiveTab) {
      // Get the canvas position
      const canvas = this.scene.game.canvas;
      const rect = canvas.getBoundingClientRect();

      // Position search input above the content area
      const tabsPadding = 12;
      const tabHeight = 40;
      const searchTop = this.root.y + tabsPadding + tabHeight + 8;

      this.searchInput.style.display = "block";
      this.searchInput.style.left = `${rect.left + this.root.x + tabsPadding}px`;
      this.searchInput.style.top = `${rect.top + searchTop}px`;
      this.searchInput.style.width = `${this.panelWidth - tabsPadding * 2 - this.handleWidth - 10}px`;
    } else {
      this.searchInput.style.display = "none";
    }
  }

  /**
   * Filter content based on search query
   * @param query - The search query
   */
  private filterContent(query: string): void {
    const q = query.toLowerCase().trim();
    const activePage = this.pages[this.activePageIndex];

    // Reset scroll when filtering
    this.scrollOffset = 0;

    if (activePage?.type === "resource") {
      // Filter resources by name only
      this.filteredResources = q
        ? this.resourceData.filter((r) => r.name.toLowerCase().includes(q))
        : [...this.resourceData];
      this.rebuildResourceGrid();
    } else if (activePage?.type === "city") {
      // Filter cities by name only
      this.filteredCities = q
        ? this.cityData.filter((c) => c.name.toLowerCase().includes(q))
        : [...this.cityData];
      this.rebuildCityGrid();
    }
  }

  /**
   * Rebuild the resource grid with filtered data
   */
  private rebuildResourceGrid(): void {
    if (!this.resourceScrollPanel) return;

    const rexUI = (this.scene as any).rexUI;
    if (!rexUI) return;

    // Destroy existing panel (but preserve hit area)
    this.resourceScrollPanel.destroy();
    if (this.resourceGridHitArea) {
      this.resourceGridContainer.remove(this.resourceGridHitArea, false);
    }
    this.resourceGridContainer.removeAll(true);

    // Recreate hit area
    this.resourceGridHitArea = this.scene.add.rectangle(0, 0, 10, 10, 0x000000, 0.001).setOrigin(0);
    this.resourceGridHitArea.setInteractive();
    this.resourceGridContainer.add(this.resourceGridHitArea);
    this.resourceGridContainer.sendToBack(this.resourceGridHitArea);

    // Show "no results" message if empty
    if (this.filteredResources.length === 0) {
      this.showNoResultsMessage(this.resourceGridContainer);
      return;
    }

    // Recreate grid and panel
    const gridSizer = this.createResourceGridSizer();
    if (!gridSizer) return;

    // Layout the grid first to get its dimensions
    gridSizer.layout();

    // RexUI uses center origin - offset by half width/height
    // Add 50px vertical offset to account for search bar
    // Use minimum x-position to keep single results visible
    const gridWidth = gridSizer.width;
    const gridHeight = gridSizer.height;
    const searchBarOffset = 50;
    const minXOffset = 75; // Half cell width + padding to keep single results visible
    gridSizer.setPosition(Math.max(gridWidth / 2, minXOffset), gridHeight / 2 + searchBarOffset);

    this.resourceScrollPanel = gridSizer;
    this.resourceGridContainer.add(gridSizer);

    // Re-layout to position correctly
    this.layout();
  }

  /**
   * Rebuild the city grid with filtered data
   */
  private rebuildCityGrid(): void {
    if (!this.cityScrollPanel) return;

    const rexUI = (this.scene as any).rexUI;
    if (!rexUI) return;

    // Destroy existing panel (but preserve hit area)
    this.cityScrollPanel.destroy();
    if (this.cityGridHitArea) {
      this.cityGridContainer.remove(this.cityGridHitArea, false);
    }
    this.cityGridContainer.removeAll(true);

    // Recreate hit area
    this.cityGridHitArea = this.scene.add.rectangle(0, 0, 10, 10, 0x000000, 0.001).setOrigin(0);
    this.cityGridHitArea.setInteractive();
    this.cityGridContainer.add(this.cityGridHitArea);
    this.cityGridContainer.sendToBack(this.cityGridHitArea);

    // Show "no results" message if empty
    if (this.filteredCities.length === 0) {
      this.showNoResultsMessage(this.cityGridContainer);
      return;
    }

    // Recreate grid and panel
    const gridSizer = this.createCityGridSizer();
    if (!gridSizer) return;

    // Layout the grid first to get its dimensions
    gridSizer.layout();

    // RexUI uses center origin - offset by half width/height
    // Add 50px vertical offset to account for search bar
    // Use minimum x-position to keep single results visible
    const gridWidth = gridSizer.width;
    const gridHeight = gridSizer.height;
    const searchBarOffset = 50;
    const minXOffset = 125; // Larger offset for city cells to keep single results visible
    gridSizer.setPosition(Math.max(gridWidth / 2, minXOffset), gridHeight / 2 + searchBarOffset);

    this.cityScrollPanel = gridSizer;
    this.cityGridContainer.add(gridSizer);

    // Re-layout to position correctly
    this.layout();
  }

  /**
   * Show "No results" message in the specified container
   */
  private showNoResultsMessage(container: Phaser.GameObjects.Container): void {
    const noResults = this.scene.add.text(100, 100, "No results found", {
      fontSize: "14px",
      color: "#94a3b8",
      fontFamily: UI_FONT_FAMILY,
      fontStyle: "italic",
    }).setOrigin(0.5);
    container.add(noResults);
  }

  destroy(): void {
    // Clean up search input
    if (this.searchInput) {
      this.searchInput.remove();
      this.searchInput = null;
    }

    // Clean up tooltip
    this.hideResourceTooltip();

    // Clean up RexUI panels
    if (this.resourceScrollPanel) {
      this.resourceScrollPanel.destroy();
      this.resourceScrollPanel = null;
    }
    if (this.cityScrollPanel) {
      this.cityScrollPanel.destroy();
      this.cityScrollPanel = null;
    }

    // Clean up mask
    if (this.contentMaskGraphics) {
      this.contentMaskGraphics.destroy();
      this.contentMaskGraphics = null;
    }
    this.contentMask = null;

    if (this.root) {
      this.root.destroy(true);
    }
  }

  private toggle(): void {
    // Preserve the handle's screen X position while the panel resizes between
    // closed/open layouts.
    const oldPanelWidth = this.panelWidth;
    const handleWorldX = this.root.x + (oldPanelWidth - this.handleWidth);

    this.isOpen = !this.isOpen;

    // Recompute panel size for open vs closed.
    this.layout();

    // Re-anchor root so the handle stays under the cursor.
    this.root.x = handleWorldX - (this.panelWidth - this.handleWidth);

    const closedX = -(this.panelWidth - this.handleWidth);
    const targetX = this.isOpen ? 0 : closedX;

    this.scene.tweens.add({
      targets: this.root,
      x: targetX,
      duration: 220,
      ease: "Cubic.Out",
    });
  }

  private setActivePage(index: number): void {
    if (index === this.activePageIndex) return;
    this.activePageIndex = index;

    // Clear search input when switching tabs
    if (this.searchInput) {
      this.searchInput.value = "";
    }

    // Reset filtered data to show all items
    this.filteredResources = [...this.resourceData];
    this.filteredCities = [...this.cityData];

    // Reset scroll position when switching tabs
    this.scrollOffset = 0;

    this.layout();
    this.updateTabStyles();
  }

  private updateTabStyles(): void {
    this.tabLabels.forEach((label, idx) => {
      label.setColor(idx === this.activePageIndex ? "#ffffff" : "#cbd5e1");
    });
    this.tabActiveIndicators.forEach((indicator, idx) => {
      indicator.setVisible(idx === this.activePageIndex);
    });

    // Also reduce the active underline color to a softer grey-blue
    this.tabActiveIndicators.forEach((indicator) => {
      indicator.setFillStyle(0x94a3b8, 1);
    });
  }

  /**
   * Check if pointer is over the content area
   */
  private isPointerOverContent(pointer: Phaser.Input.Pointer): boolean {
    if (!this.isOpen) return false;

    const activePage = this.pages[this.activePageIndex];
    const pageType = activePage?.type || "image";
    if (pageType !== "resource" && pageType !== "city" && pageType !== "cards") return false;

    // Get content area bounds in world coordinates
    const tabsPadding = 12;
    const tabHeight = 40;
    const imageTop = tabsPadding + tabHeight + 12;
    const imagePaddingX = 12;
    const imagePaddingBottom = 12;

    const contentX = this.root.x + imagePaddingX;
    const contentY = this.root.y + imageTop;
    const contentWidth = this.panelWidth - imagePaddingX * 2 - this.handleWidth;
    const contentHeight = this.panelHeight - imageTop - imagePaddingBottom;

    return (
      pointer.x >= contentX &&
      pointer.x <= contentX + contentWidth &&
      pointer.y >= contentY &&
      pointer.y <= contentY + contentHeight
    );
  }

  /**
   * Handle mouse wheel scrolling
   */
  private onMouseWheel(deltaY: number): void {
    const scrollSpeed = 30;
    const newOffset = this.scrollOffset + (deltaY > 0 ? scrollSpeed : -scrollSpeed);
    this.setScrollOffset(newOffset);
  }

  /**
   * Handle click on scrollbar track
   */
  private onTrackClick(pointer: Phaser.Input.Pointer): void {
    if (!this.scrollbarTrack || !this.scrollbarThumb) return;

    const trackBounds = this.scrollbarTrack.getBounds();
    const thumbHeight = this.scrollbarThumb.height;
    const clickY = pointer.y - trackBounds.y;

    // Calculate scroll offset based on click position
    const trackScrollRange = trackBounds.height - thumbHeight;
    if (trackScrollRange <= 0) return;

    const ratio = Math.max(0, Math.min(1, clickY / trackBounds.height));
    const newOffset = ratio * this.maxScrollOffset;
    this.setScrollOffset(newOffset);
  }

  /**
   * Handle thumb drag
   */
  private onThumbDrag(pointer: Phaser.Input.Pointer): void {
    if (!this.scrollbarTrack || !this.scrollbarThumb) return;

    const deltaY = pointer.y - this.dragStartY;
    const trackHeight = this.scrollbarTrack.height;
    const thumbHeight = this.scrollbarThumb.height;
    const trackScrollRange = trackHeight - thumbHeight;

    if (trackScrollRange <= 0) return;

    const offsetDelta = (deltaY / trackScrollRange) * this.maxScrollOffset;
    const newOffset = this.dragStartOffset + offsetDelta;
    this.setScrollOffset(newOffset);
  }

  /**
   * Set scroll offset and update content position
   */
  private setScrollOffset(offset: number): void {
    this.scrollOffset = Math.max(0, Math.min(this.maxScrollOffset, offset));
    this.updateContentPosition();
    this.updateScrollbarThumbPosition();
  }

  /**
   * Update the vertical position of content based on scroll offset
   */
  private updateContentPosition(): void {
    const activePage = this.pages[this.activePageIndex];
    const pageType = activePage?.type || "image";

    const tabsPadding = 12;
    const tabHeight = 40;
    const contentTop = tabsPadding + tabHeight + 12;
    const searchBarOffset = 50; // Offset to account for search bar
    const minXOffsetResource = 75; // Half cell width + padding to keep single results visible
    const minXOffsetCity = 125; // Larger offset for city cells

    if (pageType === "resource" && this.resourceScrollPanel) {
      const gridHeight = this.resourceScrollPanel.height || 0;
      const gridWidth = this.resourceScrollPanel.width || 0;
      this.resourceScrollPanel.setPosition(
        Math.max(gridWidth / 2, minXOffsetResource),
        gridHeight / 2 + searchBarOffset - this.scrollOffset
      );
    } else if (pageType === "city" && this.cityScrollPanel) {
      const gridHeight = this.cityScrollPanel.height || 0;
      const gridWidth = this.cityScrollPanel.width || 0;
      this.cityScrollPanel.setPosition(
        Math.max(gridWidth / 2, minXOffsetCity),
        gridHeight / 2 + searchBarOffset - this.scrollOffset
      );
    } else if (pageType === "cards") {
      // Cards container uses top-left origin
      this.cardsContainer.y = contentTop - this.scrollOffset;
    }
  }

  /**
   * Update scrollbar thumb position based on scroll offset
   */
  private updateScrollbarThumbPosition(): void {
    if (!this.scrollbarTrack || !this.scrollbarThumb) return;

    const trackHeight = this.scrollbarTrack.height;
    const thumbHeight = this.scrollbarThumb.height;
    const trackScrollRange = trackHeight - thumbHeight;

    if (this.maxScrollOffset <= 0) {
      this.scrollbarThumb.y = this.scrollbarTrack.y;
      return;
    }

    const ratio = this.scrollOffset / this.maxScrollOffset;
    this.scrollbarThumb.y = this.scrollbarTrack.y + ratio * trackScrollRange;
  }

  /**
   * Calculate max scroll offset based on content height
   */
  private calculateMaxScrollOffset(contentHeight: number, visibleHeight: number): void {
    this.contentAreaHeight = visibleHeight;
    this.maxScrollOffset = Math.max(0, contentHeight - visibleHeight);

    // Clamp current scroll offset
    if (this.scrollOffset > this.maxScrollOffset) {
      this.scrollOffset = this.maxScrollOffset;
    }
  }

  /**
   * Update scrollbar visibility and size based on content
   */
  private updateScrollbar(contentHeight: number, visibleHeight: number): void {
    if (!this.scrollbarTrack || !this.scrollbarThumb) return;

    this.calculateMaxScrollOffset(contentHeight, visibleHeight);

    // Hide scrollbar if content fits
    const needsScrollbar = contentHeight > visibleHeight;
    this.scrollbarTrack.setVisible(needsScrollbar);
    this.scrollbarThumb.setVisible(needsScrollbar);

    if (!needsScrollbar) return;

    // Calculate thumb height proportional to visible/total ratio
    const ratio = visibleHeight / contentHeight;
    const trackHeight = this.scrollbarTrack.height;
    const minThumbHeight = 30;
    const thumbHeight = Math.max(minThumbHeight, trackHeight * ratio);
    this.scrollbarThumb.height = thumbHeight;

    this.updateScrollbarThumbPosition();
  }
}

