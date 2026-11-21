import { XcreproError } from './exec.ts';

export interface Platform {
	id: string;
	destination: string;
	/** Suffix of the `<Configuration>-<suffix>` products folder; empty for macOS, which has none. */
	productsSuffix: string;
}

export const PLATFORMS: readonly Platform[] = [
	{ id: 'ios', destination: 'generic/platform=iOS', productsSuffix: 'iphoneos' },
	{ id: 'ios-sim', destination: 'generic/platform=iOS Simulator', productsSuffix: 'iphonesimulator' },
	{ id: 'catalyst', destination: 'generic/platform=macOS,variant=Mac Catalyst', productsSuffix: 'maccatalyst' },
	{ id: 'macos', destination: 'generic/platform=macOS', productsSuffix: '' },
	{ id: 'tvos', destination: 'generic/platform=tvOS', productsSuffix: 'appletvos' },
	{ id: 'tvos-sim', destination: 'generic/platform=tvOS Simulator', productsSuffix: 'appletvsimulator' },
	{ id: 'watchos', destination: 'generic/platform=watchOS', productsSuffix: 'watchos' },
	{ id: 'watchos-sim', destination: 'generic/platform=watchOS Simulator', productsSuffix: 'watchsimulator' },
	{ id: 'xros', destination: 'generic/platform=visionOS', productsSuffix: 'xros' },
	{ id: 'xros-sim', destination: 'generic/platform=visionOS Simulator', productsSuffix: 'xrsimulator' },
];

export function resolvePlatforms(ids: string[]): Platform[] {
	if (ids.length === 0) throw new XcreproError('no platforms given (e.g. --platforms ios,ios-sim)');
	return ids.map((id) => {
		const p = PLATFORMS.find((x) => x.id === id);
		if (!p) throw new XcreproError(`unknown platform "${id}". Known: ${PLATFORMS.map((x) => x.id).join(', ')}`);
		return p;
	});
}

export function productsDir(derivedDataPath: string, configuration: string, platform: Platform): string {
	const folder = platform.productsSuffix ? `${configuration}-${platform.productsSuffix}` : configuration;
	return `${derivedDataPath}/Build/Products/${folder}`;
}
