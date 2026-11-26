import 'jest-canvas-mock';
import { SettingsScene } from '../scenes/SettingsScene';
import { FullGameState, Player, PlayerColor, TrainType } from '../../shared/types/GameTypes';

// The city search pulls in an ESM-only Phaser plugin; it is not under test here.
jest.mock('../components/CityListDropDown', () => ({
    CityListDropDown: jest.fn(),
}));

const GAME_ID = 'game-1';
const CREATOR_USER_ID = 'user-creator';
const MEMBER_USER_ID = 'user-member';
const THIRD_USER_ID = 'user-third';

function makePlayer(id: string, userId: string, name: string, color: string): Player {
    return {
        id,
        userId,
        name,
        color,
        money: 50,
        trainType: TrainType.Freight,
        turnNumber: 1,
        trainState: {
            position: null,
            movementHistory: [],
            remainingMovement: 9,
            loads: [],
        },
        hand: [],
    };
}

function makeGameState(): FullGameState {
    return {
        id: GAME_ID,
        players: [
            makePlayer('player-creator', CREATOR_USER_ID, 'Creator', PlayerColor.RED),
            makePlayer('player-member', MEMBER_USER_ID, 'Member', PlayerColor.BLUE),
            makePlayer('player-third', THIRD_USER_ID, 'Third', PlayerColor.GREEN),
        ],
        currentPlayerIndex: 2,
        status: 'active',
        maxPlayers: 6,
    };
}

function jsonResponse(status: number, body: unknown): Partial<Response> {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
    };
}

describe('SettingsScene', () => {
    let scene: SettingsScene;
    let fetchMock: jest.Mock;
    /** Responses for the action endpoints, keyed by HTTP method. */
    let actionResponses: Record<string, Partial<Response>>;

    function signInAs(userId: string): void {
        localStorage.setItem('eurorails.user', JSON.stringify({ id: userId }));
        localStorage.setItem('eurorails.jwt', `token-${userId}`);
    }

    function textLabels(): string[] {
        return (scene.add.text as jest.Mock).mock.calls.map((call) => call[2] as string);
    }

    function actionCall(): [string, RequestInit & { headers: Record<string, string> }] {
        const call = fetchMock.mock.calls.find(([url]) => !String(url).includes('/api/lobby/'));
        expect(call).toBeDefined();
        return call as [string, RequestInit & { headers: Record<string, string> }];
    }

    async function openSettings(): Promise<void> {
        scene.init({ gameState: makeGameState() });
        await scene.create();
    }

    beforeEach(() => {
        // setupTests stubs localStorage with no-op mocks; back it with a real store.
        const store = new Map<string, string>();
        (localStorage.getItem as jest.Mock).mockImplementation((key: string) => store.get(key) ?? null);
        (localStorage.setItem as jest.Mock).mockImplementation((key: string, value: string) => {
            store.set(key, value);
        });
        (localStorage.removeItem as jest.Mock).mockImplementation((key: string) => {
            store.delete(key);
        });
        actionResponses = {};
        fetchMock = jest.fn((url: string, options: RequestInit = {}) => {
            if (String(url).includes(`/api/lobby/games/${GAME_ID}`)) {
                return Promise.resolve(jsonResponse(200, {
                    data: { joinCode: 'ABC123', createdBy: CREATOR_USER_ID },
                }));
            }
            const response = actionResponses[options.method ?? 'GET'];
            return Promise.resolve(response ?? jsonResponse(500, { error: 'unexpected request' }));
        });
        global.fetch = fetchMock as unknown as typeof fetch;

        scene = new SettingsScene();
        const chainable = (): Record<string, jest.Mock> => {
            const obj: Record<string, jest.Mock> = {};
            ['setOrigin', 'setInteractive', 'on', 'setStrokeStyle', 'setFillStyle', 'setText'].forEach((method) => {
                obj[method] = jest.fn(() => obj);
            });
            return obj;
        };
        scene.add = {
            text: jest.fn(chainable),
            rectangle: jest.fn(chainable),
            container: jest.fn(() => ({ add: jest.fn(), destroy: jest.fn() })),
            dom: jest.fn(chainable),
            existing: jest.fn(),
        } as any;
        scene.children = { removeAll: jest.fn() } as any;
        scene.scale = { width: 800, height: 600 } as any;
        scene.time = { delayedCall: jest.fn() } as any;
        scene.scene = {
            stop: jest.fn(),
            resume: jest.fn(),
            get: jest.fn().mockReturnValue({ gameState: {}, events: { emit: jest.fn() } }),
        } as any;
    });

    afterEach(() => {
        jest.resetAllMocks();
    });

    describe('which actions are shown', () => {
        it('shows the creator Edit on their own row, Delete on the others, and End Game', async () => {
            signInAs(CREATOR_USER_ID);
            await openSettings();

            const labels = textLabels();
            expect(labels.filter((label) => label === 'Edit')).toHaveLength(1);
            expect(labels.filter((label) => label === 'Delete')).toHaveLength(2);
            expect(labels).toContain('End Game');
        });

        it('shows a non-creator only Edit on their own row', async () => {
            signInAs(MEMBER_USER_ID);
            await openSettings();

            const labels = textLabels();
            expect(labels.filter((label) => label === 'Edit')).toHaveLength(1);
            expect(labels).not.toContain('Delete');
            expect(labels).not.toContain('End Game');
            expect(labels).toContain('Back to Lobby');
            expect(labels).toContain('Back to Game');
        });

        it('hides Delete from the creator when only two players remain', async () => {
            signInAs(CREATOR_USER_ID);
            const gameState = makeGameState();
            gameState.players.pop();
            scene.init({ gameState });
            await scene.create();

            expect(textLabels()).not.toContain('Delete');
        });
    });

    describe('editing a player', () => {
        it("sends the caller's own name and color to PATCH /api/players/me with the token", async () => {
            signInAs(MEMBER_USER_ID);
            await openSettings();
            actionResponses.PATCH = jsonResponse(200, {
                player: { id: 'player-member', name: 'Renamed', color: '#ffd700' },
            });
            const member = scene['gameState'].players[1];
            scene['editingPlayer'] = member;
            scene['nameInput'] = document.createElement('input');
            scene['nameInput'].value = '  Renamed ';
            scene['selectedColor'] = PlayerColor.YELLOW;

            await scene['savePlayerChanges']();

            const [url, options] = actionCall();
            expect(url).toContain('/api/players/me');
            expect(options.method).toBe('PATCH');
            expect(options.headers.Authorization).toBe(`Bearer token-${MEMBER_USER_ID}`);
            expect(JSON.parse(options.body as string)).toEqual({
                gameId: GAME_ID,
                name: 'Renamed',
                color: PlayerColor.YELLOW,
            });
            expect(scene['gameState'].players[1].name).toBe('Renamed');
            expect(scene['gameState'].players[1].color).toBe('#ffd700');
        });

        it("does not send anything for another player's row", async () => {
            signInAs(MEMBER_USER_ID);
            await openSettings();
            fetchMock.mockClear();
            scene['editingPlayer'] = scene['gameState'].players[0];
            scene['nameInput'] = document.createElement('input');
            scene['nameInput'].value = 'Hijacked';

            await scene['savePlayerChanges']();

            expect(fetchMock).not.toHaveBeenCalled();
            expect(scene['gameState'].players[0].name).toBe('Creator');
        });

        it('does not send an empty name', async () => {
            signInAs(MEMBER_USER_ID);
            await openSettings();
            fetchMock.mockClear();
            scene['editingPlayer'] = scene['gameState'].players[1];
            scene['nameInput'] = document.createElement('input');
            scene['nameInput'].value = '   ';

            await scene['savePlayerChanges']();

            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('keeps the old name when the server refuses', async () => {
            signInAs(MEMBER_USER_ID);
            await openSettings();
            actionResponses.PATCH = jsonResponse(409, {
                error: 'Conflict',
                details: 'Color already taken by another player',
            });
            scene['editingPlayer'] = scene['gameState'].players[1];
            scene['nameInput'] = document.createElement('input');
            scene['nameInput'].value = 'Renamed';
            scene['selectedColor'] = PlayerColor.RED;

            await scene['savePlayerChanges']();

            expect(scene['gameState'].players[1].name).toBe('Member');
            expect(textLabels()).toContain('Color already taken by another player');
        });
    });

    describe('deleting a player', () => {
        it('calls DELETE /api/game/:id/players/:playerId with the token and applies the new turn index', async () => {
            signInAs(CREATOR_USER_ID);
            await openSettings();
            actionResponses.DELETE = jsonResponse(200, { currentPlayerIndex: 1 });
            const member = scene['gameState'].players[1];

            await scene['deletePlayer'](member);

            const [url, options] = actionCall();
            expect(url).toContain(`/api/game/${GAME_ID}/players/player-member`);
            expect(options.method).toBe('DELETE');
            expect(options.headers.Authorization).toBe(`Bearer token-${CREATOR_USER_ID}`);
            expect(scene['gameState'].players.map((p) => p.id)).toEqual(['player-creator', 'player-third']);
            expect(scene['gameState'].currentPlayerIndex).toBe(1);
        });

        it('keeps the player when the server refuses', async () => {
            signInAs(MEMBER_USER_ID);
            await openSettings();
            actionResponses.DELETE = jsonResponse(403, {
                error: 'Forbidden',
                details: 'Only the game creator can delete a player',
            });

            await scene['deletePlayer'](scene['gameState'].players[2]);

            expect(scene['gameState'].players).toHaveLength(3);
            expect(textLabels()).toContain('Only the game creator can delete a player');
        });
    });

    describe('ending the game', () => {
        it('calls POST /api/game/:id/end with the token and leaves the game', async () => {
            signInAs(CREATOR_USER_ID);
            await openSettings();
            actionResponses.POST = jsonResponse(200, { message: 'Game ended successfully' });

            await scene['endGame']();

            const [url, options] = actionCall();
            expect(url).toContain(`/api/game/${GAME_ID}/end`);
            expect(options.method).toBe('POST');
            expect(options.headers.Authorization).toBe(`Bearer token-${CREATOR_USER_ID}`);
            expect(scene.scene.stop).toHaveBeenCalledWith('GameScene');
        });

        it('stays in the game when the server refuses', async () => {
            signInAs(MEMBER_USER_ID);
            await openSettings();
            actionResponses.POST = jsonResponse(403, {
                error: 'Forbidden',
                details: 'Only the game creator can end the game',
            });

            await scene['endGame']();

            expect(scene.scene.stop).not.toHaveBeenCalled();
            expect(textLabels()).toContain('Only the game creator can end the game');
        });
    });
});
