import mcDataLoader, { versions as mcVersions } from 'minecraft-data';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';


type Locale = 'ru_ru' | 'en_us';

const argv = parseArgs(process.argv.slice(2));
const ENV = {
	VERSION: stringArg('version') ?? process.env.MC_VERSION ?? '1.21.7',
	OUT_DIR: stringArg('out') ?? process.env.OUT_DIR ?? 'out',
	LOCALES: String(stringArg('locales') ?? process.env.LOCALES ?? 'ru_ru,en_us')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean) as Locale[],
	GZIP: toBool(argv.gzip ?? process.env.GZIP ?? 'false'),
	PRETTY: toBool(argv.pretty ?? process.env.PRETTY ?? 'true'),
};

const DATA_FALLBACK = '1.21.8' as const;


async function main() {
	const version = await resolveVersion(ENV.VERSION, DATA_FALLBACK);
	const mcData: any = loadMcData(version);

	await fs.mkdir(ENV.OUT_DIR, { recursive: true });
	await fs.mkdir(path.join(ENV.OUT_DIR, 'lang'), { recursive: true });

	const localeMaps = await loadLocales(version, ENV.LOCALES);

	const ru = localeMaps['ru_ru'] ?? {};
	const en = localeMaps['en_us'] ?? {};

	const blocks = (mcData.blocksArray as any[])
		.map((b) => ({
			id: b.id,
			name: b.name,
			displayNameEn: b.displayName ?? b.name,
			displayNameRu: localize(b.name, b.displayName ?? b.name, 'block', ru, en),
			states: b.states?.length ?? 0,
		}))
		.sort((a, b) => a.id - b.id);

	const items = (mcData.itemsArray as any[])
		.map((i) => ({
			id: i.id,
			name: i.name,
			displayNameEn: i.displayName ?? i.name,
			displayNameRu: localize(i.name, i.displayName ?? i.name, 'item', ru, en),
			stackSize: i.stackSize ?? 64,
		}))
		.sort((a, b) => a.id - b.id);

	const entities = (mcData.entitiesArray as any[])
		.map((e) => ({
			id: e.id,
			name: e.name,
			type: e.type,
			displayNameEn: e.displayName ?? e.name,
			displayNameRu: localize(
				e.name,
				e.displayName ?? e.name,
				'entity',
				ru,
				en
			),
		}))
		.sort((a, b) => a.id - b.id);

	const recipes: Record<number, any[]> = mcData.recipes ?? {};
	const recipeCount = countRecipes(recipes);

	await Promise.all([
		saveJson(path.join(ENV.OUT_DIR, 'blocks.json'), blocks),
		saveJson(path.join(ENV.OUT_DIR, 'items.json'), items),
		saveJson(path.join(ENV.OUT_DIR, 'entities.json'), entities),
		saveJson(path.join(ENV.OUT_DIR, 'recipes.json'), recipes),
	]);

	await Promise.all(
		Object.entries(localeMaps).map(([loc, map]) =>
			saveJson(path.join(ENV.OUT_DIR, 'lang', `${loc}.json`), map)
		)
	);

	console.log(
		[
			`✅ Dump готов (версия данных: ${version})`,
			`- blocks:   ${blocks.length}`,
			`- items:    ${items.length}`,
			`- entities: ${entities.length}`,
			`- recipes:  ${recipeCount}`,
			`Файлы: ${path.resolve(
				ENV.OUT_DIR
			)}/blocks.json, items.json, entities.json, recipes.json`,
			ENV.GZIP ? '(* также созданы .gz файлы)' : '',
		].join('\n')
	);
}


function loadMcData(version: string) {
	try {
		return mcDataLoader(version);
	} catch (e) {
		console.warn(
			`[warn] minecraft-data: не удалось загрузить "${version}", пробую fallback "${DATA_FALLBACK}"`
		);
		return mcDataLoader(DATA_FALLBACK);
	}
}

async function resolveVersion(requested: string, fallback: string) {
	if (canLoadVersion(requested)) return requested;
	if (canLoadVersion(fallback)) return fallback;
	const latestRelease = mcVersions.pc.find(
		(v: any) => v.releaseType === 'release'
	)?.minecraftVersion;
	if (latestRelease && canLoadVersion(latestRelease)) return latestRelease;

	const first = mcVersions.pc[0]?.minecraftVersion;
	if (first && canLoadVersion(first)) return first;

	throw new Error('Не удалось подобрать поддерживаемую версию minecraft-data');
}

function canLoadVersion(v: string) {
	try {
		mcDataLoader(v);
		return true;
	} catch {
		return false;
	}
}

async function loadLocales(versionId: string, locales: Locale[]) {
	const result: Record<string, Record<string, string>> = {};
	await Promise.all(
		locales.map(async (loc) => {
			try {
				const map = await loadLocale(versionId, loc);
				result[loc] = map;
			} catch {
				result[loc] = {};
			}
		})
	);
	return result;
}

async function loadLocale(versionId: string, locale: Locale) {
	try {
		const manifestUrl =
			'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
		const manifest = await fetchJson<any>(manifestUrl, {
			timeoutMs: 12_000,
			retries: 2,
		});

		const ver =
			manifest.versions.find((v: any) => v.id === versionId) ??
			manifest.versions.find((v: any) => v.id === DATA_FALLBACK);

		if (!ver) return {};

		const versionJson = await fetchJson<any>(ver.url, {
			timeoutMs: 12_000,
			retries: 2,
		});
		const assetIndexUrl = versionJson.assetIndex?.url;
		if (!assetIndexUrl) return {};

		const assetIndex = await fetchJson<any>(assetIndexUrl, {
			timeoutMs: 12_000,
			retries: 2,
		});
		const entry = assetIndex.objects?.[`minecraft/lang/${locale}.json`];
		if (!entry?.hash) return {};

		const hash: string = entry.hash;
		const url = `https://resources.download.minecraft.net/${hash.slice(
			0,
			2
		)}/${hash}`;
		const text = await fetchText(url, { timeoutMs: 12_000, retries: 2 });
		return JSON.parse(text) as Record<string, string>;
	} catch {
		return {};
	}
}

function localize(
	name: string,
	fallback: string,
	preferred: 'block' | 'item' | 'entity',
	ru: Record<string, string>,
	en: Record<string, string>
) {
	const keys = [
		`${preferred}.minecraft.${name}`,
		`block.minecraft.${name}`,
		`item.minecraft.${name}`,
		`entity.minecraft.${name}`,
	];

	for (const k of keys) {
		if (ru && ru[k]) return ru[k];
	}
	for (const k of keys) {
		if (en && en[k]) return en[k];
	}
	return fallback;
}

function countRecipes(rec: Record<number, any[]>) {
	return Object.values(rec).reduce(
		(sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
		0
	);
}

async function saveJson(filePath: string, data: unknown) {
	const json = ENV.PRETTY
		? JSON.stringify(data, null, 2)
		: JSON.stringify(data);
	await fs.writeFile(filePath, json);
	if (ENV.GZIP) {
		const gzPath = `${filePath}.gz`;
		const buf = gzipSync(Buffer.from(json));
		await fs.writeFile(gzPath, buf);
	}
}


type FetchOpts = { timeoutMs?: number; retries?: number };

async function fetchJson<T = unknown>(
	url: string,
	opts: FetchOpts = {}
): Promise<T> {
	const res = await fetchWithRetry(url, opts);
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return (await res.json()) as T;
}

async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
	const res = await fetchWithRetry(url, opts);
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return await res.text();
}

async function fetchWithRetry(
	url: string,
	{ timeoutMs = 10_000, retries = 2 }: FetchOpts
) {
	let attempt = 0;
	while (true) {
		const controller = new AbortController();
		const t = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const res = await fetch(url, { signal: controller.signal });
			clearTimeout(t);
			return res;
		} catch (err) {
			clearTimeout(t);
			if (attempt >= retries) throw err;
			await sleep(2 ** attempt * 300);
			attempt++;
		}
	}
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}


function stringArg(name: string): string | undefined {
	const value = argv[name];
	if (typeof value === 'boolean') {
		throw new Error(`--${name} requires a value (--${name}=...)`);
	}
	return value;
}

function parseArgs(raw: string[]) {
	const out: Record<string, string | boolean> = {};
	for (const token of raw) {
		if (token.startsWith('--')) {
			const [k, v] = token.slice(2).split('=', 2);
			out[k] = v === undefined ? true : v;
		}
	}
	return out;
}

function toBool(val: string | boolean) {
	if (typeof val === 'boolean') return val;
	const v = String(val).toLowerCase().trim();
	return v === '1' || v === 'true' || v === 'yes' || v === 'y';
}

main().catch((err) => {
	console.error('Ошибка в dump:', err);
	process.exit(1);
});
