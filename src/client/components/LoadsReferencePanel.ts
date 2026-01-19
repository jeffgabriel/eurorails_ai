import Phaser from "phaser";
import { UI_FONT_FAMILY } from "../config/uiFont";
import { GameState } from "../../shared/types/GameTypes";

type LoadsReferencePage = {
  key: string;
  label: string;
  type?: "image" | "cards"; // "image" uses texture key, "cards" renders dynamic content
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
    const firstImagePage = this.pages.find(p => p.type !== "cards") || this.pages[0];
    this.image = this.scene.add.image(0, 0, firstImagePage.key).setOrigin(0.5, 0.5);
    this.image.setVisible(this.pages[this.activePageIndex].type !== "cards");
    
    // Cards container (for cards-type pages)
    this.cardsContainer = this.scene.add.container(0, 0);
    this.cardsContainer.setVisible(this.pages[this.activePageIndex].type === "cards");

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

    this.root.add([this.background, tabsBar, this.image, this.cardsContainer, this.handleContainer]);

    // Keep references for layout
    (this.root as any).__loadsTabsBar = tabsBar as Phaser.GameObjects.Container;

    this.layout();
    this.updateTabStyles();
  }

  layout(): void {
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
    const isCardsPage = activePage?.type === "cards";
    
    let scaledW: number;
    let scaledH: number;
    
    if (isCardsPage) {
      // For cards page, use similar dimensions to image pages (don't expand)
      // Use the first image page as reference for consistent sizing
      const firstImagePage = this.pages.find(p => p.type !== "cards");
      if (firstImagePage) {
        const refSource = this.scene.textures.get(firstImagePage.key).getSourceImage() as
          | HTMLImageElement
          | HTMLCanvasElement
          | ImageBitmap;
        const refW: number = refSource.width;
        const refH: number = refSource.height;
        const maxImageHeight = maxPanelHeight - imageTop - imagePaddingBottom;
        const maxImageWidth = maxPanelWidth - imagePaddingX * 2;
        const scale = Math.min(1, maxImageWidth / refW, maxImageHeight / refH);
        scaledW = Math.floor(refW * scale);
        scaledH = Math.floor(refH * scale);
      } else {
        // Fallback if no image pages exist
        scaledW = 400;
        scaledH = 400;
      }
    } else {
      // Determine panel size based on scaled image size (so it doesn't slide out farther than needed)
      this.image.setTexture(this.pages[this.activePageIndex].key);
      const source = this.scene.textures.get(this.pages[this.activePageIndex].key).getSourceImage() as
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
    this.background.width = this.panelWidth;
    this.background.height = this.panelHeight;

    // Tabs
    const tabsBar: Phaser.GameObjects.Container = (this.root as any).__loadsTabsBar;
    const numTabs = this.pages.length;
    const totalGapWidth = tabGap * (numTabs - 1);
    const tabWidth = Math.max(120, Math.floor((this.panelWidth - tabsPadding * 2 - totalGapWidth) / numTabs));

    tabsBar.x = tabsPadding;
    tabsBar.y = tabsPadding;

    this.pages.forEach((_, idx) => {
      const tab = this.tabContainers[idx];

      tab.x = idx * (tabWidth + tabGap);
      tab.y = 0;

      const hit = this.tabHitAreas[idx];
      hit.width = tabWidth;
      hit.height = tabHeight;
      // Phaser input hit areas don't automatically follow width/height mutations
      hit.setSize(tabWidth, tabHeight);

      const text = this.tabLabels[idx];
      text.x = 10;
      text.y = 10;

      const indicator = this.tabActiveIndicators[idx];
      indicator.width = tabWidth;
      indicator.height = 3;
      indicator.x = 0;
      indicator.y = tabHeight - 3;
    });

    // Handle is anchored so it remains visible at x=0 when closed.
    this.handleContainer.x = this.panelWidth - this.handleWidth;
    this.handleContainer.y = 0;
    this.handleBg.height = this.handleHeight;
    this.handleBg.setSize(this.handleWidth, this.handleHeight);
    this.handleText.x = this.handleWidth / 2;
    this.handleText.y = Math.floor(this.handleHeight / 2);

    // Content area below tabs (image or cards)
    if (isCardsPage) {
      // Hide image, show cards container
      this.image.setVisible(false);
      this.cardsContainer.setVisible(true);
      
      // Position cards container
      this.cardsContainer.x = imagePaddingX;
      this.cardsContainer.y = imageTop;
      
      // Render cards content
      this.renderCardsContent();
    } else {
      // Show image, hide cards container
      this.image.setVisible(true);
      this.cardsContainer.setVisible(false);
      
      // Image area below tabs
      const source = this.scene.textures.get(this.pages[this.activePageIndex].key).getSourceImage() as
        | HTMLImageElement
        | HTMLCanvasElement
        | ImageBitmap;
      const srcW: number = source.width;
      const srcH: number = source.height;
      
      const maxImageWidthForPanel = this.panelWidth - imagePaddingX * 2;
      const maxImageHeightForPanel = this.panelHeight - imageTop - imagePaddingBottom;
      const scaleForPanel = Math.min(1, maxImageWidthForPanel / srcW, maxImageHeightForPanel / srcH);
      this.image.setScale(scaleForPanel);
      this.image.x = Math.floor(this.panelWidth / 2);
      this.image.y = Math.floor(imageTop + maxImageHeightForPanel / 2);
    }
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

  destroy(): void {
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
}

