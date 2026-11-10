import { clampPanelScrollLeft, isPanelWiderThanScreen } from '../utils/panelScroll';

describe('panelScroll', () => {
  describe('clampPanelScrollLeft', () => {
    // 980px of content in a 300px visible area (411px phone minus ~111px pinned controls)
    const contentWidth = 980;
    const visibleWidth = 300;

    it('does not scroll past the start of the content', () => {
      expect(clampPanelScrollLeft(50, contentWidth, visibleWidth)).toBe(0);
    });

    it('does not scroll past the end of the content', () => {
      expect(clampPanelScrollLeft(-2000, contentWidth, visibleWidth)).toBe(visibleWidth - contentWidth);
    });

    it('keeps in-range values', () => {
      expect(clampPanelScrollLeft(-250, contentWidth, visibleWidth)).toBe(-250);
    });

    it('pins to 0 when the content fits', () => {
      expect(clampPanelScrollLeft(-40, 280, visibleWidth)).toBe(0);
    });
  });

  describe('isPanelWiderThanScreen', () => {
    it('detects an overflowing panel', () => {
      expect(isPanelWiderThanScreen(1130, 411)).toBe(true);
    });

    it('treats a panel that fits (within 1px) as not overflowing', () => {
      expect(isPanelWiderThanScreen(1920, 1920)).toBe(false);
      expect(isPanelWiderThanScreen(1920.5, 1920)).toBe(false);
    });
  });
});
