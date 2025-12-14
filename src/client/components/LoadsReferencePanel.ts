import Phaser from "phaser";

type LoadsReferencePage = {
  key: string;
  label: string;
};

export class LoadsReferencePanel {
  private readonly scene: Phaser.Scene;
  private readonly pages: LoadsReferencePage[];

  private root!: Phaser.GameObjects.Container;
  private background!: Phaser.GameObjects.Rectangle;
  private handleContainer!: Phaser.GameObjects.Container;
  private handleBg!: Phaser.GameObjects.Rectangle;
  private handleText!: Phaser.GameObjects.Text;
  private image!: Phaser.GameObjects.Image;
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

  constructor(scene: Phaser.Scene, pages: LoadsReferencePage[]) {
    this.scene = scene;
    this.pages = pages;
  }

  getContainer(): Phaser.GameObjects.Container {
    return this.root;
  }

  create(): void {
    this.root = this.scene.add.container(0, 20);
    this.root.setDepth(100_000);

    // Background + click-blocker (prevents clicks going to game underneath)
    this.background = this.scene.add.rectangle(0, 0, 10, 10, 0x101827, 0.92).setOrigin(0);
    this.background.setStrokeStyle(2, 0x334155, 1);
    this.background.setInteractive();

    // Tabs (two pages)
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

    // Image
    this.image = this.scene.add.image(0, 0, this.pages[this.activePageIndex].key).setOrigin(0.5, 0.5);

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
      })
      .setOrigin(0.5);
    this.handleText.setRotation(-Math.PI / 2);

    this.handleContainer.add([this.handleBg, this.handleText]);

    this.root.add([this.background, tabsBar, this.image, this.handleContainer]);

    // Keep references for layout
    (this.root as any).__loadsTabsBar = tabsBar as Phaser.GameObjects.Container;

    this.layout();
    this.updateTabStyles();
  }

  layout(): void {
    const width = this.scene.scale.width;
    const height = this.scene.scale.height;

    const marginY = 18;
    this.root.y = marginY;

    const tabsPadding = 12;
    const tabHeight = 40;
    const tabGap = 8;
    const imagePaddingX = 12;
    const imagePaddingBottom = 12;
    const imageTop = tabsPadding + tabHeight + 12;

    // Constrain panel to viewport (never exceed)
    const maxPanelWidth = Math.max(360, Math.floor(width * 0.92));
    const maxPanelHeight = Math.max(320, Math.floor(height - marginY * 2));

    // Determine panel size based on scaled image size (so it doesn't slide out farther than needed)
    this.image.setTexture(this.pages[this.activePageIndex].key);
    const source = this.scene.textures.get(this.pages[this.activePageIndex].key).getSourceImage() as
      | HTMLImageElement
      | HTMLCanvasElement
      | ImageBitmap;

    // @ts-expect-error - width/height exist on all supported source image types
    const srcW: number = source.width;
    // @ts-expect-error - width/height exist on all supported source image types
    const srcH: number = source.height;

    const maxImageHeight = maxPanelHeight - imageTop - imagePaddingBottom;
    const maxImageWidth = maxPanelWidth - imagePaddingX * 2;

    const scale = Math.min(1, maxImageWidth / srcW, maxImageHeight / srcH);
    const scaledW = Math.floor(srcW * scale);
    const scaledH = Math.floor(srcH * scale);

    // Ensure panel is wide enough for both tab labels (so tabs are clickable and text fits),
    // while still keeping it "image-sized" when possible.
    const estimatedLabelWidths = this.tabLabels.map((t) => Math.ceil(t.getBounds().width));
    const minTabWidths = estimatedLabelWidths.map((w) => Math.max(140, w + 20));
    // Extra breathing room so tab labels never get clipped by rounding/layout.
    const minWidthForTabs =
      tabsPadding * 2 + minTabWidths.reduce((a, b) => a + b, 0) + tabGap + 40;

    this.panelWidth = Math.min(
      maxPanelWidth,
      Math.max(this.handleWidth + 20, scaledW + imagePaddingX * 2, minWidthForTabs)
    );
    this.panelHeight = Math.min(maxPanelHeight, Math.max(220, imageTop + scaledH + imagePaddingBottom));

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
    const tabWidth = Math.max(160, Math.floor((this.panelWidth - tabsPadding * 2 - tabGap) / 2));

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

    // Image area below tabs
    const maxImageWidthForPanel = this.panelWidth - imagePaddingX * 2;
    const maxImageHeightForPanel = this.panelHeight - imageTop - imagePaddingBottom;
    const scaleForPanel = Math.min(1, maxImageWidthForPanel / srcW, maxImageHeightForPanel / srcH);
    this.image.setScale(scaleForPanel);
    this.image.x = Math.floor(this.panelWidth / 2);
    this.image.y = Math.floor(imageTop + maxImageHeightForPanel / 2);
  }

  destroy(): void {
    if (this.root) {
      this.root.destroy(true);
    }
  }

  private toggle(): void {
    this.isOpen = !this.isOpen;

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

