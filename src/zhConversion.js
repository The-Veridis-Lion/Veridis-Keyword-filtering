import { extensionName, getAppContext, runtimeState } from './state.js';
import { logger } from './log.js';

const OPENCC_DICTIONARY_COMMIT = '2736adb0f27d8c2e2747ea58dfaa016c41503cc4';
export const ZH_DICTIONARY_PACKAGE_VERSION = `opencc-${OPENCC_DICTIONARY_COMMIT.slice(0, 12)}-zh-variant-v1`;
const OPENCC_DICTIONARY_BASE_URL = `https://raw.githubusercontent.com/BYVoid/OpenCC/${OPENCC_DICTIONARY_COMMIT}/data/dictionary`;
const CACHE_KEY = `${extensionName}:zh-variant-dictionary:${ZH_DICTIONARY_PACKAGE_VERSION}`;
const MAX_VARIANTS_PER_TARGET = 96;

const DICTIONARY_FILES = [
    { name: 'STCharacters.txt', bucket: 'base', group: 's2t', bytes: 35832, entries: 4011, sha256: '5f1ed494af5a5fc793be3693cc9f151c980e3d78c6b12626a084a91f79eee1b3' },
    { name: 'STPhrases.txt', bucket: 'base', group: 's2t', bytes: 1012478, entries: 49385, sha256: 'dc04ae06cb7d53152494e83bcf4ee7ceb623c9a766a705060b0bae23986dddcd' },
    { name: 'TSCharacters.txt', bucket: 'base', group: 't2s', bytes: 104369, entries: 4143, sha256: '795f53d3f3a29284f9325e2efe64215e199a53339a22b666342aad3ab1e6e722' },
    { name: 'TSPhrases.txt', bucket: 'base', group: 't2s', bytes: 8620, entries: 469, sha256: 'ed408a9addd621a0523dde359dfa392e378d65b44fc50293fdc7c1456b83c5c9' },
    { name: 'TWPhrases.txt', bucket: 'tw', group: 'tw', bytes: 17769, entries: 776, sha256: '4798f5c6297c29595b28a1272c3be633282fffedd2c24c049c6fcdb3155cd8b6' },
    { name: 'TWVariants.txt', bucket: 'tw', group: 'tw', bytes: 554, entries: 38, sha256: '75d5c5b83220dfd0c22ff500081b553da4e447ff6b1822fec44f40e4b33c0a56' },
    { name: 'TWVariantsRevPhrases.txt', bucket: 'tw', group: 'tw', bytes: 20983, entries: 1004, sha256: '4cc2de3f6b3bc8034f217bf98023264ad1e3deecccd7ed0a3ff7c4176ca0a8e2' },
    { name: 'HKVariants.txt', bucket: 'hk', group: 'hk', bytes: 774, entries: 63, sha256: '3a06c3619d17d739203be6452045786b2298b0eec81b8a2a4b9a372b6346ecb2' },
    { name: 'HKVariantsRevPhrases.txt', bucket: 'hk', group: 'hk', bytes: 22520, entries: 1073, sha256: 'f2d3046e3fd8f8b8abfca8668df3e13f9dfe218b320d078a99701bec08b37d15' },
];

const EXPECTED_TOTAL_BYTES = DICTIONARY_FILES.reduce((sum, file) => sum + file.bytes, 0);
const EXPECTED_TOTAL_ENTRIES = DICTIONARY_FILES.reduce((sum, file) => sum + file.entries, 0);
const EXPECTED_PACKAGE_DIGEST_SOURCE = DICTIONARY_FILES.map((file) => `${file.name}:${file.sha256}`).join('|');

function getSettings() {
    return getAppContext().extension_settings?.[extensionName] || {};
}

function normalizeBoolean(value, fallback = true) {
    return typeof value === 'boolean' ? value : fallback;
}

export function normalizeZhVariantOptions(options = {}) {
    return {
        tw: normalizeBoolean(options?.tw, true),
        hk: normalizeBoolean(options?.hk, true),
    };
}

export function normalizeZhVariantSettings(settings = getSettings()) {
    if (!settings || typeof settings !== 'object') return settings;
    settings.zhVariantCompatEnabled = settings.zhVariantCompatEnabled === true;
    settings.zhVariantCompatOptions = normalizeZhVariantOptions(settings.zhVariantCompatOptions);
    if (!settings.zhVariantDictionary || typeof settings.zhVariantDictionary !== 'object') {
        settings.zhVariantDictionary = {};
    }
    settings.zhVariantDictionary = {
        status: ['missing', 'verified', 'failed'].includes(settings.zhVariantDictionary.status)
            ? settings.zhVariantDictionary.status
            : 'missing',
        packageVersion: String(settings.zhVariantDictionary.packageVersion || ''),
        verifiedAt: Number(settings.zhVariantDictionary.verifiedAt) || 0,
        bytes: Number(settings.zhVariantDictionary.bytes) || 0,
        entries: Number(settings.zhVariantDictionary.entries) || 0,
        fileCount: Number(settings.zhVariantDictionary.fileCount) || 0,
        digest: String(settings.zhVariantDictionary.digest || ''),
        lastError: String(settings.zhVariantDictionary.lastError || ''),
    };
    return settings;
}

export function getZhVariantCompatOptions(settings = getSettings()) {
    return normalizeZhVariantOptions(settings?.zhVariantCompatOptions);
}

function getStorage() {
    try {
        return window?.localStorage || null;
    } catch (e) {
        logger.warn('无法访问 localStorage，增强简繁词典不可缓存', e);
        return null;
    }
}

function readCachedPackage() {
    const storage = getStorage();
    if (!storage) return null;
    try {
        const raw = storage.getItem(CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.packageVersion !== ZH_DICTIONARY_PACKAGE_VERSION) return null;
        if (!parsed.files || typeof parsed.files !== 'object') return null;
        return parsed;
    } catch (e) {
        logger.warn('读取增强简繁词典缓存失败', e);
        return null;
    }
}

function writeCachedPackage(packagePayload) {
    const storage = getStorage();
    if (!storage) throw new Error('无法访问浏览器本地缓存，词典包不能持久保存。');
    storage.setItem(CACHE_KEY, JSON.stringify(packagePayload));
}

function updateSettingsDictionaryMeta(meta, status = 'verified', error = '', targetSettings = getSettings()) {
    const settings = targetSettings;
    normalizeZhVariantSettings(settings);
    const currentMeta = settings.zhVariantDictionary || {};
    settings.zhVariantDictionary = {
        status,
        packageVersion: status === 'verified' ? ZH_DICTIONARY_PACKAGE_VERSION : '',
        verifiedAt: status === 'verified'
            ? Number(meta?.verifiedAt || currentMeta.verifiedAt) || Date.now()
            : 0,
        bytes: status === 'verified' ? EXPECTED_TOTAL_BYTES : 0,
        entries: status === 'verified' ? EXPECTED_TOTAL_ENTRIES : 0,
        fileCount: status === 'verified' ? DICTIONARY_FILES.length : 0,
        digest: status === 'verified' ? meta?.digest || '' : '',
        lastError: error,
    };
}

function uniqueValues(values) {
    const seen = new Set();
    const result = [];
    values.forEach((value) => {
        const normalized = String(value ?? '');
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        result.push(normalized);
    });
    return result;
}

function addMapValue(map, key, value) {
    const source = String(key ?? '').trim();
    const target = String(value ?? '').trim();
    if (!source || !target || source === target) return;
    if (!map.has(source)) map.set(source, new Set());
    map.get(source).add(target);
}

function addBidirectionalVariant(bucket, source, target) {
    const isCharVariant = Array.from(source).length === 1 && Array.from(target).length === 1;
    addMapValue(isCharVariant ? bucket.charVariants : bucket.phraseVariants, source, target);
    addMapValue(isCharVariant ? bucket.charVariants : bucket.phraseVariants, target, source);
}

function parseDictionaryEntries(text) {
    const entries = [];
    String(text || '').split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const [sourceColumn, ...targetColumns] = trimmed.split(/\t+/);
        const source = String(sourceColumn || '').trim();
        const targets = targetColumns.join(' ').trim().split(/\s+/).map((target) => target.trim()).filter(Boolean);
        if (!source || targets.length === 0) return;
        entries.push({ source, targets });
    });
    return entries;
}

function createEmptyIndex() {
    return {
        buckets: {
            base: { charVariants: new Map(), phraseVariants: new Map() },
            tw: { charVariants: new Map(), phraseVariants: new Map() },
            hk: { charVariants: new Map(), phraseVariants: new Map() },
        },
        groups: {
            s2t: [],
            t2s: [],
            tw: [],
            hk: [],
        },
    };
}

function sortConversionEntries(entries) {
    return entries.sort((a, b) => b.source.length - a.source.length || a.source.localeCompare(b.source));
}

function bucketConversionEntries(entries) {
    const byFirstChar = new Map();
    entries.forEach((entry) => {
        const firstChar = entry.source[0] || '';
        if (!firstChar) return;
        if (!byFirstChar.has(firstChar)) byFirstChar.set(firstChar, []);
        byFirstChar.get(firstChar).push(entry);
    });
    return { entries, byFirstChar };
}

function buildDictionaryIndex(files) {
    const index = createEmptyIndex();

    DICTIONARY_FILES.forEach((fileDef) => {
        const text = files[fileDef.name];
        const entries = parseDictionaryEntries(text);
        const bucket = index.buckets[fileDef.bucket];
        entries.forEach((entry) => {
            const cleanTargets = uniqueValues(entry.targets);
            cleanTargets.forEach((target) => addBidirectionalVariant(bucket, entry.source, target));
            index.groups[fileDef.group].push({ source: entry.source, targets: cleanTargets });
        });
    });

    Object.keys(index.groups).forEach((groupKey) => {
        index.groups[groupKey] = bucketConversionEntries(sortConversionEntries(index.groups[groupKey]));
    });

    return index;
}

function setRuntimeDictionary(packagePayload) {
    const index = buildDictionaryIndex(packagePayload.files);
    runtimeState.zhVariantDictionary = {
        ready: true,
        packageVersion: ZH_DICTIONARY_PACKAGE_VERSION,
        commit: OPENCC_DICTIONARY_COMMIT,
        verifiedAt: packagePayload.verifiedAt || Date.now(),
        digest: packagePayload.digest || '',
        index,
    };
}

export function restoreZhDictionaryPackageFromCache(settings = getSettings()) {
    normalizeZhVariantSettings(settings);
    if (runtimeState.zhVariantDictionary?.ready === true
        && runtimeState.zhVariantDictionary.packageVersion === ZH_DICTIONARY_PACKAGE_VERSION) {
        updateSettingsDictionaryMeta({
            digest: runtimeState.zhVariantDictionary.digest || '',
            verifiedAt: runtimeState.zhVariantDictionary.verifiedAt,
        }, 'verified', '', settings);
        return true;
    }

    const cached = readCachedPackage();
    if (!cached || cached.status !== 'verified') return false;

    try {
        setRuntimeDictionary(cached);
        updateSettingsDictionaryMeta({
            digest: cached.digest || '',
            verifiedAt: cached.verifiedAt,
        }, 'verified', '', settings);
        return true;
    } catch (e) {
        logger.warn('增强简繁词典缓存无法加载，需要重新下载', e);
        runtimeState.zhVariantDictionary = null;
        settings.zhVariantDictionary = {
            status: 'failed',
            packageVersion: '',
            verifiedAt: 0,
            bytes: 0,
            entries: 0,
            fileCount: 0,
            digest: '',
            lastError: e?.message || '缓存无法加载',
        };
        settings.zhVariantCompatEnabled = false;
        return false;
    }
}

export function isZhDictionaryReady(settings = getSettings()) {
    if (runtimeState.zhVariantDictionary?.ready === true
        && runtimeState.zhVariantDictionary.packageVersion === ZH_DICTIONARY_PACKAGE_VERSION) {
        normalizeZhVariantSettings(settings);
        updateSettingsDictionaryMeta({
            digest: runtimeState.zhVariantDictionary.digest || '',
            verifiedAt: runtimeState.zhVariantDictionary.verifiedAt,
        }, 'verified', '', settings);
        return true;
    }
    return restoreZhDictionaryPackageFromCache(settings);
}

export function hasVerifiedZhDictionaryPackageMeta(settings = getSettings()) {
    normalizeZhVariantSettings(settings);
    if (runtimeState.zhVariantDictionary?.ready === true
        && runtimeState.zhVariantDictionary.packageVersion === ZH_DICTIONARY_PACKAGE_VERSION) {
        return true;
    }
    const meta = settings?.zhVariantDictionary || {};
    return meta.status === 'verified'
        && meta.packageVersion === ZH_DICTIONARY_PACKAGE_VERSION
        && Number(meta.bytes) === EXPECTED_TOTAL_BYTES
        && Number(meta.entries) === EXPECTED_TOTAL_ENTRIES
        && Number(meta.fileCount) === DICTIONARY_FILES.length
        && Boolean(meta.digest);
}

export function getZhDictionaryPackageStatus(settings = getSettings(), options = {}) {
    normalizeZhVariantSettings(settings);
    const shouldHydrate = options?.hydrate === true;
    const ready = shouldHydrate
        ? isZhDictionaryReady(settings)
        : hasVerifiedZhDictionaryPackageMeta(settings);
    const meta = settings?.zhVariantDictionary || {};
    return {
        ready,
        status: ready ? 'verified' : meta.status || 'missing',
        packageVersion: ready ? ZH_DICTIONARY_PACKAGE_VERSION : meta.packageVersion || '',
        bytes: EXPECTED_TOTAL_BYTES,
        entries: EXPECTED_TOTAL_ENTRIES,
        fileCount: DICTIONARY_FILES.length,
        commit: OPENCC_DICTIONARY_COMMIT,
        lastError: meta.lastError || '',
        options: getZhVariantCompatOptions(settings),
    };
}

export function getZhDictionaryPackageStats() {
    return {
        packageVersion: ZH_DICTIONARY_PACKAGE_VERSION,
        commit: OPENCC_DICTIONARY_COMMIT,
        bytes: EXPECTED_TOTAL_BYTES,
        entries: EXPECTED_TOTAL_ENTRIES,
        fileCount: DICTIONARY_FILES.length,
    };
}

function escapeRegExpLiteral(value) {
    return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeRegExpCharClassValue(value) {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/\]/g, '\\]')
        .replace(/\^/g, '\\^')
        .replace(/-/g, '\\-');
}

function getActiveBuckets(options = {}) {
    const normalized = normalizeZhVariantOptions(options);
    const dictionary = runtimeState.zhVariantDictionary;
    if (!dictionary?.ready) return [];
    const buckets = [dictionary.index.buckets.base];
    if (normalized.tw) buckets.push(dictionary.index.buckets.tw);
    if (normalized.hk) buckets.push(dictionary.index.buckets.hk);
    return buckets;
}

function getActiveGroupEntries(options = {}) {
    const normalized = normalizeZhVariantOptions(options);
    const dictionary = runtimeState.zhVariantDictionary;
    if (!dictionary?.ready) return [];
    const groups = [
        dictionary.index.groups.s2t,
        dictionary.index.groups.t2s,
    ];
    if (normalized.tw) groups.push(dictionary.index.groups.tw);
    if (normalized.hk) groups.push(dictionary.index.groups.hk);
    return groups;
}

function getMapVariants(mapName, value, options = {}) {
    const source = String(value ?? '');
    const variants = [];
    getActiveBuckets(options).forEach((bucket) => {
        const mapped = bucket?.[mapName]?.get(source);
        if (!mapped) return;
        mapped.forEach((item) => variants.push(item));
    });
    return uniqueValues(variants);
}

export function getChineseCharVariants(char, options = {}) {
    const source = String(char ?? '');
    if (!source) return [];
    return uniqueValues([source, ...getMapVariants('charVariants', source, options)]);
}

function getChinesePhraseVariants(value, options = {}) {
    const source = String(value ?? '');
    if (!source) return [];
    return getMapVariants('phraseVariants', source, options);
}

function convertByEntries(value, entries = []) {
    const source = String(value ?? '');
    const entryList = Array.isArray(entries) ? entries : entries?.entries;
    if (!source || !Array.isArray(entryList) || entryList.length === 0) return source;
    let output = '';
    let cursor = 0;

    while (cursor < source.length) {
        let matched = null;
        const candidates = entries?.byFirstChar?.get(source[cursor]) || entryList;
        for (const entry of candidates) {
            if (source.startsWith(entry.source, cursor)) {
                matched = entry;
                break;
            }
        }
        if (matched) {
            output += matched.targets[0] || matched.source;
            cursor += matched.source.length;
            continue;
        }
        output += source[cursor];
        cursor++;
    }

    return output;
}

export function getChineseTextVariants(value, options = {}) {
    const source = String(value ?? '');
    if (!source || !runtimeState.zhVariantDictionary?.ready) return source ? [source] : [];

    const seen = new Set([source]);
    const queue = [{ value: source, depth: 0 }];
    const groupEntries = getActiveGroupEntries(options);

    while (queue.length > 0 && seen.size < MAX_VARIANTS_PER_TARGET) {
        const current = queue.shift();
        const addVariant = (candidate) => {
            const normalized = String(candidate ?? '');
            if (!normalized || seen.has(normalized) || seen.size >= MAX_VARIANTS_PER_TARGET) return;
            seen.add(normalized);
            queue.push({ value: normalized, depth: current.depth + 1 });
        };

        getChinesePhraseVariants(current.value, options).forEach(addVariant);

        if (current.depth >= 2) continue;
        groupEntries.forEach((entries) => addVariant(convertByEntries(current.value, entries)));
    }

    return [...seen].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function buildCharVariantPattern(value, options = {}) {
    return Array.from(String(value ?? '')).map((char) => {
        const variants = getChineseCharVariants(char, options).sort((a, b) => a.localeCompare(b));
        if (variants.length <= 1) return escapeRegExpLiteral(char);
        return `[${variants.map(escapeRegExpCharClassValue).join('')}]`;
    }).join('');
}

export function buildChineseVariantPattern(value, options = {}) {
    const source = String(value ?? '');
    if (!source) return '';
    if (!runtimeState.zhVariantDictionary?.ready) return escapeRegExpLiteral(source);

    const variantPatterns = uniqueValues(
        getChineseTextVariants(source, options).map((variant) => buildCharVariantPattern(variant, options))
    );
    if (variantPatterns.length <= 1) return variantPatterns[0] || escapeRegExpLiteral(source);
    return `(?:${variantPatterns.join('|')})`;
}

export function getChineseTextVariantLengths(value, options = {}) {
    return uniqueValues(getChineseTextVariants(value, options).map((variant) => String(variant).length));
}

export function convertChineseText(value, direction) {
    const source = String(value ?? '');
    if (!source || !runtimeState.zhVariantDictionary?.ready) return value;
    const dictionary = runtimeState.zhVariantDictionary;
    const entries = direction === 't2s'
        ? dictionary.index.groups.t2s
        : dictionary.index.groups.s2t;
    return convertByEntries(source, entries);
}

function convertStringArray(values, direction) {
    return Array.isArray(values) ? values.map((value) => convertChineseText(String(value ?? ''), direction)) : [];
}

function convertOptionalString(value, direction) {
    return typeof value === 'string' ? convertChineseText(value, direction) : value;
}

export function convertRuleListChinese(rules, direction) {
    return (Array.isArray(rules) ? rules : []).map((rule) => {
        const nextRule = { ...(rule || {}) };
        nextRule.name = convertOptionalString(nextRule.name, direction);
        nextRule.subRules = (Array.isArray(nextRule.subRules) ? nextRule.subRules : []).map((subRule) => ({
            ...(subRule || {}),
            targets: convertStringArray(subRule?.targets, direction),
            replacements: convertStringArray(subRule?.replacements, direction),
            remark: convertOptionalString(subRule?.remark, direction),
        }));
        return nextRule;
    });
}

async function sha256Hex(text) {
    if (!window?.crypto?.subtle) throw new Error('当前浏览器不支持 SHA-256 校验。');
    const bytes = new TextEncoder().encode(String(text ?? ''));
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hashBuffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function packageDigestHex() {
    return sha256Hex(EXPECTED_PACKAGE_DIGEST_SOURCE);
}

async function fetchDictionaryFile(fileDef, signal, onChunkProgress = () => {}) {
    const response = await fetch(`${OPENCC_DICTIONARY_BASE_URL}/${fileDef.name}`, { cache: 'no-store', signal });
    if (!response.ok) throw new Error(`${fileDef.name} 下载失败：HTTP ${response.status}`);

    const total = Number(response.headers.get('content-length')) || fileDef.bytes;
    if (!response.body?.getReader) {
        const text = await response.text();
        onChunkProgress(1, fileDef.name);
        return text;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let received = 0;
    let text = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        text += decoder.decode(value, { stream: true });
        onChunkProgress(total > 0 ? Math.min(received / total, 1) : 0, fileDef.name);
    }
    text += decoder.decode();
    onChunkProgress(1, fileDef.name);
    return text;
}

async function verifyDownloadedFiles(files, onProgress = () => {}) {
    let verifiedEntries = 0;

    for (let index = 0; index < DICTIONARY_FILES.length; index++) {
        const fileDef = DICTIONARY_FILES[index];
        const text = files[fileDef.name];
        if (typeof text !== 'string' || text.length === 0) throw new Error(`${fileDef.name} 内容为空。`);

        const bytes = new TextEncoder().encode(text).length;
        if (bytes !== fileDef.bytes) throw new Error(`${fileDef.name} 大小异常：${bytes}/${fileDef.bytes}`);

        const hash = await sha256Hex(text);
        if (hash !== fileDef.sha256) throw new Error(`${fileDef.name} 校验失败。`);

        const entries = parseDictionaryEntries(text).length;
        if (entries !== fileDef.entries) throw new Error(`${fileDef.name} 条目异常：${entries}/${fileDef.entries}`);

        verifiedEntries += entries;
        onProgress((index + 1) / DICTIONARY_FILES.length, `正在校验词典完整性：${index + 1}/${DICTIONARY_FILES.length}`);
    }

    if (verifiedEntries !== EXPECTED_TOTAL_ENTRIES) {
        throw new Error(`词典条目合计异常：${verifiedEntries}/${EXPECTED_TOTAL_ENTRIES}`);
    }
}

export async function downloadZhDictionaryPackage(options = {}) {
    const {
        signal,
        onProgress = () => {},
    } = options;

    runtimeState.zhDictionaryInstallCancelRequested = false;
    onProgress({ ratio: 0.02, statusText: '正在连接 GitHub 词典源。' });

    const files = {};
    let completedBytes = 0;
    const downloadedFileBytes = new Map();

    for (let index = 0; index < DICTIONARY_FILES.length; index++) {
        const fileDef = DICTIONARY_FILES[index];
        const baseProgress = index / DICTIONARY_FILES.length;
        const text = await fetchDictionaryFile(fileDef, signal, (fileRatio) => {
            const previous = downloadedFileBytes.get(fileDef.name) || 0;
            const current = Math.round(fileDef.bytes * fileRatio);
            completedBytes += Math.max(0, current - previous);
            downloadedFileBytes.set(fileDef.name, current);
            const ratio = 0.05 + (0.62 * (baseProgress + fileRatio / DICTIONARY_FILES.length));
            onProgress({
                ratio,
                statusText: `正在下载增强简繁词典：${fileDef.name} (${Math.round(Math.min(completedBytes / EXPECTED_TOTAL_BYTES, 1) * 100)}%)`,
            });
        });
        files[fileDef.name] = text;
    }

    onProgress({ ratio: 0.72, statusText: '下载完成，正在校验文件完整性。' });
    await verifyDownloadedFiles(files, (ratio, statusText) => {
        onProgress({ ratio: 0.72 + ratio * 0.13, statusText });
    });

    onProgress({ ratio: 0.88, statusText: '完整性通过，正在建立匹配索引。' });
    const digest = await packageDigestHex();
    const packagePayload = {
        status: 'verified',
        packageVersion: ZH_DICTIONARY_PACKAGE_VERSION,
        commit: OPENCC_DICTIONARY_COMMIT,
        verifiedAt: Date.now(),
        bytes: EXPECTED_TOTAL_BYTES,
        entries: EXPECTED_TOTAL_ENTRIES,
        fileCount: DICTIONARY_FILES.length,
        digest,
        files,
    };

    setRuntimeDictionary(packagePayload);
    onProgress({ ratio: 0.94, statusText: '正在写入本地缓存。' });
    writeCachedPackage(packagePayload);
    updateSettingsDictionaryMeta({ digest, verifiedAt: packagePayload.verifiedAt }, 'verified');
    onProgress({ ratio: 1, statusText: '增强简繁词典已验证并启用。' });

    return {
        packageVersion: ZH_DICTIONARY_PACKAGE_VERSION,
        commit: OPENCC_DICTIONARY_COMMIT,
        bytes: EXPECTED_TOTAL_BYTES,
        entries: EXPECTED_TOTAL_ENTRIES,
        fileCount: DICTIONARY_FILES.length,
        digest,
    };
}

export function markZhDictionaryInstallFailed(error) {
    const message = error?.name === 'AbortError'
        ? '用户取消下载'
        : String(error?.message || error || '下载失败');
    updateSettingsDictionaryMeta(null, 'failed', message);
    runtimeState.zhVariantDictionary = null;
    return message;
}
