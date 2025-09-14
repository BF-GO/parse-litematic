import mcDataLoader from 'minecraft-data';
import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_VERSION = process.env.MC_VERSION || '1.21.7';
const DATA_FALLBACK = '1.21.8';

async function main() {
	const mcData: any = loadMcData(DATA_VERSION);
	await fs.mkdir('out', { recursive: true });

	// Локали из asset index
	const ru = await loadLocale(DATA_VERSION, 'ru_ru');
	const en = await loadLocale(DATA_VERSION, 'en_us');

	// ---- Blocks
	const blocks = mcData.blocksArray.map((b: any) => ({
		id: b.id,
		name: b.name,
		displayNameEn: b.displayName ?? b.name,
		displayNameRu: localize(ru, b.name, b.displayName ?? b.name, 'block'),
		states: b.states?.length ?? 0,
	}));

	// ---- Items
	const items = mcData.itemsArray.map((i: any) => ({
		id: i.id,
		name: i.name,
		displayNameEn: i.displayName ?? i.name,
		displayNameRu: localize(ru, i.name, i.displayName ?? i.name, 'item'),
		stackSize: i.stackSize ?? 64,
	}));

	// ---- Entities
	const entities = mcData.entitiesArray.map((e: any) => ({
		id: e.id,
		name: e.name,
		type: e.type,
		displayNameEn: e.displayName ?? e.name,
		displayNameRu: localize(ru, e.name, e.displayName ?? e.name, 'entity'),
	}));

	// ---- Recipes (object: { [id]: Recipe[] })
	const recipes: Record<number, any[]> = mcData.recipes ?? {};
	const recipeCount = countRecipes(recipes);

	// Save
	await fs.writeFile(
		path.join('out', 'blocks.json'),
		JSON.stringify(blocks, null, 2)
	);
	await fs.writeFile(
		path.join('out', 'items.json'),
		JSON.stringify(items, null, 2)
	);
	await fs.writeFile(
		path.join('out', 'entities.json'),
		JSON.stringify(entities, null, 2)
	);
	await fs.writeFile(
		path.join('out', 'recipes.json'),
		JSON.stringify(recipes, null, 2)
	);

	console.log(`✅ Dump готов:
- blocks:   ${blocks.length}
- items:    ${items.length}
- entities: ${entities.length}
- recipes:  ${recipeCount}
Файлы: ./out/blocks.json, items.json, entities.json, recipes.json`);
}

function loadMcData(version: string) {
	try {
		return mcDataLoader(version);
	} catch {
		return mcDataLoader(DATA_FALLBACK);
	}
}

// ---- Language loading via asset index
async function loadLocale(versionId: string, locale: 'ru_ru' | 'en_us') {
	try {
		const manifestUrl =
			'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
		const manifest = await fetchJson<any>(manifestUrl);

		const ver =
			manifest.versions.find((v: any) => v.id === versionId) ??
			manifest.versions.find((v: any) => v.id === DATA_FALLBACK);

		if (!ver) return {};

		const versionJson = await fetchJson<any>(ver.url);
		const assetIndexUrl = versionJson.assetIndex?.url;
		if (!assetIndexUrl) return {};

		const assetIndex = await fetchJson<any>(assetIndexUrl);
		const entry = assetIndex.objects?.[`minecraft/lang/${locale}.json`];
		if (!entry?.hash) return {};

		const hash: string = entry.hash;
		const url = `https://resources.download.minecraft.net/${hash.slice(
			0,
			2
		)}/${hash}`;
		const text = await (await fetch(url)).text();
		return JSON.parse(text) as Record<string, string>;
	} catch {
		return {};
	}
}

function localize(
	lang: Record<string, string>,
	name: string,
	fallback: string,
	preferred: 'block' | 'item' | 'entity'
) {
	const keys = [
		`${preferred}.minecraft.${name}`,
		`block.minecraft.${name}`,
		`item.minecraft.${name}`,
		`entity.minecraft.${name}`,
	];
	for (const k of keys) if (lang && lang[k]) return lang[k];
	return fallback;
}

function countRecipes(rec: Record<number, any[]>) {
	return Object.values(rec).reduce(
		(sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
		0
	);
}

async function fetchJson<T = unknown>(url: string): Promise<T> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return (await res.json()) as T;
}

main().catch((err) => {
	console.error('Ошибка в dump:', err);
	process.exit(1);
});
