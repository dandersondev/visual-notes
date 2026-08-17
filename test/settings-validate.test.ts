// Guards the two places untyped data enters settings. Both used to accept
// anything shaped loosely enough: tile import checked only `Array.isArray`, and
// loadSettings() merged data.json straight into the defaults. A bad value
// survived and failed later at a render site, where nothing pointed back here.
import { describe, it, expect } from 'vitest';
import { validateTileImport, normalizeSettings } from '../src/settings-validate';
import { DEFAULT_SETTINGS, type Tile, type VisualNotesSettings } from '../src/types';

const tile = (over: Partial<Tile> = {}): Tile =>
  ({ id: 't1', label: 'Tile', icon: '📁', color: '#fff', kind: 'folder', ...over });

const settings = (over: Partial<VisualNotesSettings> = {}): VisualNotesSettings =>
  ({ ...DEFAULT_SETTINGS, ...over });

describe('validateTileImport', () => {
  it('accepts a valid array, including nested children', () => {
    const input = [tile(), tile({ id: 't2', kind: 'board', children: [tile({ id: 'c1' })] })];
    const result = validateTileImport(input);
    expect('error' in result).toBe(false);
    expect('tiles' in result && result.tiles).toEqual(input);
  });

  it('accepts an empty array', () => {
    expect(validateTileImport([])).toEqual({ tiles: [] });
  });

  it.each([
    ['a bare object', { id: 'x' }],
    ['a string', '[]'],
    ['null', null],
    ['a number', 7],
  ])('rejects %s', (_label, input) => {
    expect(validateTileImport(input)).toHaveProperty('error');
  });

  it.each([
    ['missing id', { ...tile(), id: undefined }],
    ['numeric label', { ...tile(), label: 42 }],
    ['unknown kind', { ...tile(), kind: 'spreadsheet' }],
    ['non-string targetPath', { ...tile(), targetPath: 3 }],
    ['children not an array', { ...tile(), children: {} }],
  ])('rejects an entry with %s', (_label, bad) => {
    const result = validateTileImport([bad]);
    expect(result).toHaveProperty('error');
    // The message must name the offending entry — a bare "invalid" gives the
    // user nothing to fix in a long pasted array.
    expect('error' in result && result.error).toMatch(/tile\[0\]/);
  });

  it('reports the index of a bad entry deeper in the array', () => {
    const result = validateTileImport([tile(), tile(), { nope: true }]);
    expect('error' in result && result.error).toMatch(/tile\[2\]/);
  });

  it('rejects an invalid nested child, naming its path', () => {
    const result = validateTileImport([tile({ children: [tile(), { nope: true }] })]);
    expect('error' in result && result.error).toMatch(/tile\[0\]\.children\[1\]/);
  });

  it('is all-or-nothing — one bad entry rejects the whole import', () => {
    // A partial import that silently dropped tiles would be worse than a
    // refusal, because it replaces the user's existing data either way.
    expect(validateTileImport([tile(), { nope: true }])).toHaveProperty('error');
  });
});

describe('normalizeSettings', () => {
  it('leaves valid settings untouched', () => {
    const input = settings({ rootTiles: [tile()], panButton: 'right', dotSize: 2 });
    expect(normalizeSettings(input)).toEqual(input);
  });

  it('drops individual invalid tiles rather than all of them', () => {
    // Per-field, unlike import: one corrupt entry in data.json must not cost
    // the rest of the user's board.
    const good = tile({ id: 'keep' });
    const out = normalizeSettings(settings({ rootTiles: [good, { nope: true } as unknown as Tile] }));
    expect(out.rootTiles).toEqual([good]);
  });

  it('replaces a non-array rootTiles with an empty array', () => {
    const out = normalizeSettings(settings({ rootTiles: 'nope' as unknown as Tile[] }));
    expect(out.rootTiles).toEqual([]);
  });

  it.each([
    ['toolbarPosition', 'diagonal'],
    ['mobileFabPosition', 'middle'],
    ['panButton', 'scroll'],
  ] as const)('drops out-of-range enum %s so the default applies', (key, bad) => {
    const out = normalizeSettings(settings({ [key]: bad } as Partial<VisualNotesSettings>));
    expect(out[key]).toBeUndefined();
  });

  it('keeps valid enum values', () => {
    expect(normalizeSettings(settings({ toolbarPosition: 'bottom' })).toolbarPosition).toBe('bottom');
    expect(normalizeSettings(settings({ collaborationTransport: 'websocket' })).collaborationTransport).toBe('private-network');
    expect(normalizeSettings(settings({ collaborationTransport: 'private-network' })).collaborationTransport).toBe('private-network');
  });

  it('purges dormant hosted collaboration and OIDC configuration', () => {
    const out = normalizeSettings(settings({
      collaborationServerUrl: 'wss://hosted.example',
      collaborationDevelopmentToken: 'development-secret',
      collaborationAuthentication: 'oidc',
      collaborationOidcIssuer: 'https://issuer.example',
      collaborationOidcClientId: 'public-client',
      collaborationOidcScope: 'openid offline_access',
      collaborationOidcAudience: 'https://api.example',
      collaborationPrivateNetworkToken: 'a-legacy-plaintext-private-network-secret',
    }));
    expect(out).not.toHaveProperty('collaborationServerUrl');
    expect(out).not.toHaveProperty('collaborationDevelopmentToken');
    expect(out).not.toHaveProperty('collaborationAuthentication');
    expect(out).not.toHaveProperty('collaborationOidcIssuer');
    expect(out).not.toHaveProperty('collaborationOidcClientId');
    expect(out).not.toHaveProperty('collaborationOidcScope');
    expect(out).not.toHaveProperty('collaborationOidcAudience');
    expect(out).not.toHaveProperty('collaborationPrivateNetworkToken');
  });

  // The hosted/OIDC stack is still compiled into the bundle as a dormant
  // foundation: the Auth0 settings rows, the browser sign-in client, and the
  // server's OIDC mode. The ONLY thing keeping all of it unreachable is that
  // normalizeSettings can never hand back 'websocket' -- every one of those
  // settings rows is rendered behind that exact comparison. If this invariant
  // is ever relaxed, the dormant UI and the shared development token become
  // live again in the same instant, so assert it directly rather than trusting
  // a reviewer to notice.
  it.each([
    ['a hand-edited websocket transport', { collaborationTransport: 'websocket' as const }],
    ['websocket plus a hosted URL', {
      collaborationTransport: 'websocket' as const,
      collaborationServerUrl: 'wss://hosted.example',
    }],
    ['websocket plus OIDC', {
      collaborationTransport: 'websocket' as const,
      collaborationAuthentication: 'oidc' as const,
    }],
    ['websocket with collaboration switched on', {
      collaborationTransport: 'websocket' as const,
      experimentalCollaboration: true,
    }],
  ])('never yields the hosted websocket transport from %s', (_label, over) => {
    expect(normalizeSettings(settings(over)).collaborationTransport).not.toBe('websocket');
  });

  it.each([
    ['dotSize', 'big'],
    ['snapGridSize', -1],
    ['trashZoneSize', 0],
    ['bookmarkCacheDays', Number.NaN],
  ] as const)('drops non-positive-number %s', (key, bad) => {
    const out = normalizeSettings(settings({ [key]: bad } as Partial<VisualNotesSettings>));
    expect(out[key]).toBeUndefined();
  });

  it('clamps cardDragAnimationIntensity into its documented 0.5-2 range', () => {
    // Clamped, not dropped: the intent is legible, only the magnitude is wrong.
    expect(normalizeSettings(settings({ cardDragAnimationIntensity: 9 })).cardDragAnimationIntensity).toBe(2);
    expect(normalizeSettings(settings({ cardDragAnimationIntensity: 0.1 })).cardDragAnimationIntensity).toBe(0.5);
    expect(normalizeSettings(settings({ cardDragAnimationIntensity: 1.5 })).cardDragAnimationIntensity).toBe(1.5);
  });

  it('drops wrong-typed strings and booleans', () => {
    const out = normalizeSettings(settings({
      dotColor: 123 as unknown as string,
      snapToGrid: 'yes' as unknown as boolean,
    }));
    expect(out.dotColor).toBeUndefined();
    expect(out.snapToGrid).toBeUndefined();
  });

  it('validates experimental collaboration settings without enabling them', () => {
    const out = normalizeSettings(settings({
      experimentalCollaboration: 'yes' as unknown as boolean,
      collaborationClientId: 42 as unknown as string,
      collaborationDisplayName: 'Daniel',
      collaborationColor: '#abcdef',
      collaborationAuthentication: 'password' as unknown as 'oidc',
      collaborationOidcIssuer: 42 as unknown as string,
      collaborationOidcAudience: 42 as unknown as string,
    }));
    expect(out.experimentalCollaboration).toBeUndefined();
    expect(out.collaborationClientId).toBeUndefined();
    expect(out.collaborationDisplayName).toBe('Daniel');
    expect(out.collaborationColor).toBe('#abcdef');
    expect(out.collaborationAuthentication).toBeUndefined();
    expect(out.collaborationOidcIssuer).toBeUndefined();
    expect(out.collaborationOidcAudience).toBeUndefined();
  });

  it('coerces a non-boolean openOnStartup back to the default', () => {
    // Not optional, so it can't be dropped — it has to land on the default.
    const out = normalizeSettings(settings({ openOnStartup: 'true' as unknown as boolean }));
    expect(out.openOnStartup).toBe(DEFAULT_SETTINGS.openOnStartup);
  });

  it('drops a non-object penDrawOptions', () => {
    expect(normalizeSettings(settings({ penDrawOptions: 'x' as never })).penDrawOptions).toBeUndefined();
  });

  it('leaves absent optional fields absent', () => {
    const out = normalizeSettings(settings());
    expect('legacyBackup' in out).toBe(false);
    expect('preImportBackup' in out).toBe(false);
  });

  it('sanitises legacyBackup and preImportBackup when present', () => {
    const good = tile();
    const out = normalizeSettings(settings({
      legacyBackup: [good, { nope: true } as unknown as Tile],
      preImportBackup: 'nope' as unknown as Tile[],
    }));
    expect(out.legacyBackup).toEqual([good]);
    expect(out.preImportBackup).toEqual([]);
  });

  it('does not mutate its input', () => {
    const input = settings({ rootTiles: [tile(), { nope: true } as unknown as Tile] });
    normalizeSettings(input);
    expect(input.rootTiles).toHaveLength(2);
  });
});
