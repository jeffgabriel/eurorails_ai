import "phaser";

export class AutoRunBadge {
  private background: Phaser.GameObjects.Rectangle;
  private label: Phaser.GameObjects.Text;
  private container: Phaser.GameObjects.Container;

  constructor(scene: Phaser.Scene) {
    const cam = scene.cameras.main;
    const padding = 8;
    const fontSize = 14;

    this.label = scene.add.text(0, 0, "AUTO-RUN", {
      fontFamily: "Arial, sans-serif",
      fontSize: `${fontSize}px`,
      color: "#ffffff",
      fontStyle: "bold",
    });
    this.label.setOrigin(0.5, 0.5);

    const bgWidth = this.label.width + padding * 2;
    const bgHeight = this.label.height + padding * 2;

    this.background = scene.add.rectangle(0, 0, bgWidth, bgHeight, 0x22c55e);
    this.background.setOrigin(0.5, 0.5);

    this.container = scene.add.container(
      cam.width - bgWidth / 2 - 12,
      bgHeight / 2 + 12,
      [this.background, this.label],
    );
    this.container.setDepth(1000);
    this.container.setScrollFactor(0);
    this.container.setVisible(false);
  }

  setVisible(enabled: boolean): void {
    this.container.setVisible(enabled);
  }

  destroy(): void {
    this.container.destroy(true);
  }
}
