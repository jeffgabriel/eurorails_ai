import { create } from 'zustand';

interface GameSettingsState {
  fastModeEnabled: boolean;
}

interface GameSettingsActions {
  setFastMode: (enabled: boolean) => void;
  toggleFastMode: () => void;
}

type GameSettingsStore = GameSettingsState & GameSettingsActions;

export const useGameSettingsStore = create<GameSettingsStore>((set) => ({
  fastModeEnabled: false,

  setFastMode: (enabled: boolean) => {
    set({ fastModeEnabled: enabled });
  },

  toggleFastMode: () => {
    set((state) => ({ fastModeEnabled: !state.fastModeEnabled }));
  },
}));
