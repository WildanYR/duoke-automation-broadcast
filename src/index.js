import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import TOML from '@iarna/toml';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const SELECTORS = Object.freeze({
  bootstrapLoader: 'img[alt="loading"][src*="loading1.gif"]',
  appShell: '.main_cont',
  conversationList: '.conversation_list_container',
  conversationRow:
    '.conversation_list_container div[role="listitem"]:has(.buyer_name)',
  buyerName: '.buyer_name',
  listPrompt: '.conversation_list_container .infinite-status-prompt',
  listEmpty: '.conversation_list_container .dk_empty',
  listEmptyDescription: '.conversation_list_container .dk_empty__description',
  activeBuyer: '.cont_header .buyer_name',
  history: '.cont_body .message_main',
  messages: '.cont_body .message_main > li',
  outgoingMessages: '.cont_body .message_main > li.rt',
  historyPrompt: '.cont_body .message_main .infinite-status-prompt',
  historyEmpty: '.cont_body .message_main .dk_empty',
  composerFallback: '.cont_footer textarea[maxlength="600"]',
  sendButton: '.cont_footer button:has(i.icon_send_chatbox)',
});

function log(message, details) {
  const prefix = `[${new Date().toISOString()}]`;
  if (details === undefined) {
    console.log(prefix, message);
  } else {
    console.log(prefix, message, details);
  }
}

function parseArgs(argv) {
  const args = { config: 'config.toml' };

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config') {
      if (!argv[i + 1]) {
        throw new Error('--config membutuhkan path file TOML');
      }
      args.config = argv[i + 1];
      i += 1;
      continue;
    }

    if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node src/index.js [--config config.toml]');
      process.exit(0);
    }

    throw new Error(`Argumen tidak dikenal: ${argv[i]}`);
  }

  return args;
}

function resolveFromProject(value) {
  if (path.isAbsolute(value)) return value;
  return path.resolve(PROJECT_ROOT, value);
}

function readConfig(configPathInput) {
  const configPath = resolveFromProject(configPathInput);
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = TOML.parse(raw);

  const messages = parsed.chat?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('[chat].messages harus berupa array dan minimal memiliki 1 pesan');
  }

  for (const [index, message] of messages.entries()) {
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new Error(`[chat].messages[${index}] harus string non-kosong`);
    }
  }

  const automation = parsed.automation ?? {};
  const config = {
    duoke: {
      url: parsed.duoke?.url ?? 'https://web.duoke.com/#/dk/main/chat',
      profileDir: resolveFromProject(parsed.duoke?.profile_dir ?? '.duoke-profile'),
      headless: parsed.duoke?.headless ?? false,
    },
    storage: {
      sqlitePath: resolveFromProject(
        parsed.storage?.sqlite_path ?? 'duoke-sent.sqlite',
      ),
    },
    automation: {
      loginTimeoutMs: automation.login_timeout_ms ?? 300_000,
      stateTimeoutMs: automation.state_timeout_ms ?? 15_000,
      collectionTimeoutMs: automation.collection_timeout_ms ?? 600_000,
      pollIntervalMs: automation.poll_interval_ms ?? 150,
      scrollStepRatio: automation.scroll_step_ratio ?? 0.8,
      bottomProbeIntervalMs: automation.bottom_probe_interval_ms ?? 750,
      bottomStableRounds: automation.bottom_stable_rounds ?? 4,
      historyEmptyStableRounds: automation.history_empty_stable_rounds ?? 4,
      betweenMessagesMs: automation.between_messages_ms ?? 500,
      betweenBuyersMs: automation.between_buyers_ms ?? 800,
    },
    chat: {
      messages,
    },
  };

  validateConfig(config);
  return config;
}

function validatePositiveNumber(name, value, { allowZero = false } = {}) {
  const valid =
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (allowZero ? value >= 0 : value > 0);

  if (!valid) {
    throw new Error(`${name} harus berupa angka ${allowZero ? '>= 0' : '> 0'}`);
  }
}

function validateConfig(config) {
  if (typeof config.duoke.url !== 'string' || !config.duoke.url.startsWith('http')) {
    throw new Error('[duoke].url harus URL http/https');
  }

  validatePositiveNumber('login_timeout_ms', config.automation.loginTimeoutMs);
  validatePositiveNumber('state_timeout_ms', config.automation.stateTimeoutMs);
  validatePositiveNumber(
    'collection_timeout_ms',
    config.automation.collectionTimeoutMs,
  );
  validatePositiveNumber('poll_interval_ms', config.automation.pollIntervalMs);
  validatePositiveNumber('scroll_step_ratio', config.automation.scrollStepRatio);
  validatePositiveNumber(
    'bottom_probe_interval_ms',
    config.automation.bottomProbeIntervalMs,
  );
  validatePositiveNumber('bottom_stable_rounds', config.automation.bottomStableRounds);
  validatePositiveNumber(
    'history_empty_stable_rounds',
    config.automation.historyEmptyStableRounds,
  );
  validatePositiveNumber(
    'between_messages_ms',
    config.automation.betweenMessagesMs,
    { allowZero: true },
  );
  validatePositiveNumber(
    'between_buyers_ms',
    config.automation.betweenBuyersMs,
    { allowZero: true },
  );
}

function openDatabase(sqlitePath) {
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const db = new Database(sqlitePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS buyers (
      buyer_name TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sent_messages (
      buyer_name TEXT NOT NULL,
      message_key TEXT NOT NULL,
      message_index INTEGER NOT NULL,
      message_sha256 TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed')),
      claimed_at TEXT NOT NULL,
      confirmed_at TEXT,
      PRIMARY KEY (buyer_name, message_key)
    );

    CREATE INDEX IF NOT EXISTS idx_sent_messages_buyer
      ON sent_messages (buyer_name);
  `);

  return {
    db,
    isBuyerComplete: db.prepare(
      'SELECT 1 FROM buyers WHERE buyer_name = ? LIMIT 1',
    ),
    getMessageCheckpoint: db.prepare(
      'SELECT status, claimed_at, confirmed_at FROM sent_messages WHERE buyer_name = ? AND message_key = ? LIMIT 1',
    ),
    claimMessage: db.prepare(`
      INSERT INTO sent_messages (
        buyer_name,
        message_key,
        message_index,
        message_sha256,
        status,
        claimed_at,
        confirmed_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, NULL)
    `),
    confirmMessage: db.prepare(`
      UPDATE sent_messages
      SET status = 'confirmed', confirmed_at = ?
      WHERE buyer_name = ? AND message_key = ? AND status = 'pending'
    `),
    markBuyerComplete: db.prepare(`
      INSERT INTO buyers (buyer_name, completed_at)
      VALUES (?, ?)
      ON CONFLICT(buyer_name)
      DO UPDATE SET completed_at = excluded.completed_at
    `),
  };
}

function messageIdentity(index, message) {
  const sha256 = crypto.createHash('sha256').update(message).digest('hex');
  return {
    sha256,
    key: crypto
      .createHash('sha256')
      .update(`${index}\0${message}`)
      .digest('hex'),
  };
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim();
}

async function sleep(page, ms) {
  if (ms <= 0) return;
  await page.waitForTimeout(ms);
}

async function anyVisible(locator) {
  const count = await locator.count();
  for (let i = 0; i < count; i += 1) {
    if (await locator.nth(i).isVisible().catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function visibleTexts(locator) {
  const out = [];
  const count = await locator.count();
  for (let i = 0; i < count; i += 1) {
    const item = locator.nth(i);
    if (!(await item.isVisible().catch(() => false))) continue;
    out.push(normalizeText(await item.innerText().catch(() => '')));
  }
  return out.filter(Boolean);
}

async function visibleLocatorWithText(locator, text) {
  const texts = await visibleTexts(locator);
  return texts.some((value) => value.includes(text));
}

async function waitUntil({
  page,
  timeoutMs,
  pollIntervalMs,
  label,
  check,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastState;

  while (Date.now() < deadline) {
    const result = await check();
    const state = typeof result === 'object' && result !== null ? result.state : result;

    if (state && state !== lastState) {
      log(`${label}: ${state}`);
      lastState = state;
    }

    if (typeof result === 'object' && result !== null && result.done) {
      return result;
    }

    await sleep(page, pollIntervalMs);
  }

  throw new Error(`${label}: TIMEOUT setelah ${timeoutMs}ms (state terakhir: ${lastState ?? 'unknown'})`);
}

async function waitForPageShell(page, config) {
  const shell = page.locator(SELECTORS.appShell);
  const list = page.locator(SELECTORS.conversationList);
  const bootstrap = page.locator(SELECTORS.bootstrapLoader);

  return waitUntil({
    page,
    timeoutMs: config.automation.loginTimeoutMs,
    pollIntervalMs: config.automation.pollIntervalMs,
    label: 'PAGE',
    check: async () => {
      const shellVisible = await shell.isVisible().catch(() => false);
      const listVisible = await list.isVisible().catch(() => false);

      if (shellVisible && listVisible) {
        return { done: true, state: 'PAGE_SHELL_READY' };
      }

      const bootstrapVisible = await anyVisible(bootstrap);
      if (bootstrapVisible) {
        return { done: false, state: 'PAGE_BOOTSTRAP_LOADING' };
      }

      return { done: false, state: 'PAGE_WAITING_LOGIN_OR_SHELL' };
    },
  });
}

async function detectConversationListState(page) {
  const list = page.locator(SELECTORS.conversationList);
  if (!(await list.isVisible().catch(() => false))) {
    return { state: 'LIST_NOT_AVAILABLE', rowCount: 0 };
  }

  const prompts = page.locator(SELECTORS.listPrompt);
  if (await visibleLocatorWithText(prompts, 'Chat loading')) {
    return { state: 'LIST_LOADING', rowCount: 0 };
  }

  const rows = page.locator(SELECTORS.conversationRow);
  const rowCount = await rows.count();
  if (rowCount > 0) {
    return { state: 'LIST_READY_DATA', rowCount };
  }

  if (await anyVisible(page.locator(SELECTORS.listEmpty))) {
    return {
      state: 'LIST_READY_EMPTY',
      rowCount: 0,
      emptyText: (await visibleTexts(page.locator(SELECTORS.listEmptyDescription))).join(' | '),
    };
  }

  return { state: 'LIST_PENDING_UNKNOWN', rowCount: 0 };
}

async function waitForConversationListReady(page, config) {
  return waitUntil({
    page,
    timeoutMs: config.automation.stateTimeoutMs,
    pollIntervalMs: config.automation.pollIntervalMs,
    label: 'CONVERSATION_LIST',
    check: async () => {
      const current = await detectConversationListState(page);
      return {
        ...current,
        done:
          current.state === 'LIST_READY_DATA' ||
          current.state === 'LIST_READY_EMPTY',
      };
    },
  });
}

async function waitForListNotLoading(page, config) {
  return waitUntil({
    page,
    timeoutMs: config.automation.stateTimeoutMs,
    pollIntervalMs: config.automation.pollIntervalMs,
    label: 'LIST_LOAD_CYCLE',
    check: async () => {
      const current = await detectConversationListState(page);
      const done =
        current.state === 'LIST_READY_DATA' ||
        current.state === 'LIST_READY_EMPTY';
      return { ...current, done };
    },
  });
}

async function readVisibleBuyerNames(page) {
  const rows = page.locator(SELECTORS.conversationRow);
  const count = await rows.count();
  const names = [];

  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    if (!(await row.isVisible().catch(() => false))) continue;

    const name = normalizeText(
      await row.locator(SELECTORS.buyerName).first().innerText().catch(() => ''),
    );
    if (name) names.push(name);
  }

  return names;
}

async function rowIntersectsConversationViewport(row) {
  return row.evaluate((element) => {
    const container = element.closest('.conversation_list_container');
    if (!container) return false;

    let current = element.parentElement;
    let scroller = null;

    while (current && container.contains(current)) {
      const style = window.getComputedStyle(current);
      const overflowY = style.overflowY;
      const scrollable =
        current.clientHeight > 0 &&
        current.scrollHeight - current.clientHeight > 2 &&
        (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay');

      if (scrollable) {
        scroller = current;
        break;
      }

      if (current === container) break;
      current = current.parentElement;
    }

    scroller ??= container;

    const rowRect = element.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();

    return (
      rowRect.width > 0 &&
      rowRect.height > 0 &&
      rowRect.bottom > scrollerRect.top + 1 &&
      rowRect.top < scrollerRect.bottom - 1
    );
  });
}

async function runOnConversationScroller(page, operation, amount = 0) {
  const list = page.locator(SELECTORS.conversationList);

  return list.evaluate(
    (container, { operation: op, amount: scrollAmount }) => {
      const candidates = [container, ...container.querySelectorAll('*')];
      const scrollables = candidates
        .map((element) => {
          const style = window.getComputedStyle(element);
          const overflowY = style.overflowY;
          const delta = element.scrollHeight - element.clientHeight;
          return { element, overflowY, delta };
        })
        .filter(
          ({ element, overflowY, delta }) =>
            element.clientHeight > 0 &&
            delta > 2 &&
            (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay'),
        )
        .sort((a, b) => b.delta - a.delta);

      const scroller = scrollables[0]?.element ?? container;

      if (op === 'top') {
        scroller.scrollTop = 0;
      } else if (op === 'bottom') {
        scroller.scrollTop = scroller.scrollHeight;
      } else if (op === 'by') {
        scroller.scrollTop = Math.max(
          0,
          Math.min(scroller.scrollHeight, scroller.scrollTop + scrollAmount),
        );
      } else if (op === 'ratio') {
        const ratio = Math.max(0, Math.min(1, scrollAmount));
        const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        scroller.scrollTop = Math.round(maxScrollTop * ratio);
      }

      return {
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        atTop: scroller.scrollTop <= 1,
        atBottom:
          scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2,
      };
    },
    { operation, amount },
  );
}

async function findPinnedBuyerRowInCurrentViewport(page, targetName) {
  const rows = page.locator(SELECTORS.conversationRow);
  const count = await rows.count();

  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    if (!(await row.isVisible().catch(() => false))) continue;

    const name = normalizeText(
      await row.locator(SELECTORS.buyerName).first().innerText().catch(() => ''),
    );
    if (name !== targetName) continue;

    const inViewport = await rowIntersectsConversationViewport(row).catch(() => false);
    if (!inViewport) continue;

    const handle = await row.elementHandle();
    if (!handle) continue;

    const pinnedName = normalizeText(
      await handle
        .$eval(SELECTORS.buyerName, (element) => element.textContent ?? '')
        .catch(() => ''),
    );

    if (pinnedName === targetName) return handle;
    await handle.dispose();
  }

  return null;
}

async function getVisibleBuyerOrdinalRange(page, buyerOrdinalByName) {
  const rows = page.locator(SELECTORS.conversationRow);
  const count = await rows.count();
  const ordinals = [];

  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    if (!(await row.isVisible().catch(() => false))) continue;
    if (!(await rowIntersectsConversationViewport(row).catch(() => false))) continue;

    const name = normalizeText(
      await row.locator(SELECTORS.buyerName).first().innerText().catch(() => ''),
    );
    const ordinal = buyerOrdinalByName?.get(name);
    if (Number.isInteger(ordinal)) ordinals.push(ordinal);
  }

  if (ordinals.length === 0) return null;

  return {
    min: Math.min(...ordinals),
    max: Math.max(...ordinals),
  };
}

async function collectAllBuyerNames(page, config) {
  const initialState = await waitForConversationListReady(page, config);
  if (initialState.state === 'LIST_READY_EMPTY') {
    return [];
  }

  await runOnConversationScroller(page, 'top');
  await sleep(page, config.automation.pollIntervalMs);

  const seen = new Set();
  const deadline = Date.now() + config.automation.collectionTimeoutMs;
  let stableBottomRounds = 0;
  let previousBottomFingerprint = '';

  while (Date.now() < deadline) {
    const listState = await waitForListNotLoading(page, config);
    if (listState.state === 'LIST_READY_EMPTY') return [];

    const beforeSize = seen.size;
    for (const name of await readVisibleBuyerNames(page)) {
      seen.add(name);
    }

    const metrics = await runOnConversationScroller(page, 'read');
    const newBuyerCount = seen.size - beforeSize;

    log(
      `SCAN buyers=${seen.size} visible_new=${newBuyerCount} scroll=${Math.round(metrics.scrollTop)}/${Math.round(metrics.scrollHeight)}`,
    );

    if (!metrics.atBottom) {
      stableBottomRounds = 0;
      previousBottomFingerprint = '';
      const step = Math.max(
        1,
        Math.floor(metrics.clientHeight * config.automation.scrollStepRatio),
      );
      await runOnConversationScroller(page, 'by', step);
      await sleep(page, config.automation.pollIntervalMs);
      continue;
    }

    // Trigger infinite-load boundary again. Jika backend menambah data,
    // scrollHeight/nama buyer akan berubah dan stability counter di-reset.
    await runOnConversationScroller(page, 'bottom');
    await sleep(page, config.automation.bottomProbeIntervalMs);

    const stateAfterProbe = await detectConversationListState(page);
    if (stateAfterProbe.state === 'LIST_LOADING') {
      stableBottomRounds = 0;
      previousBottomFingerprint = '';
      await waitForListNotLoading(page, config);
      continue;
    }

    const sizeBeforeProbeRead = seen.size;
    for (const name of await readVisibleBuyerNames(page)) {
      seen.add(name);
    }
    const afterMetrics = await runOnConversationScroller(page, 'read');

    const fingerprint = [
      seen.size,
      Math.round(afterMetrics.scrollHeight),
      Math.round(afterMetrics.clientHeight),
      afterMetrics.atBottom,
    ].join('|');

    const noNewBuyer = seen.size === sizeBeforeProbeRead;
    const stable =
      afterMetrics.atBottom &&
      noNewBuyer &&
      fingerprint === previousBottomFingerprint;

    if (stable) {
      stableBottomRounds += 1;
      log(
        `SCAN_BOTTOM_STABLE ${stableBottomRounds}/${config.automation.bottomStableRounds}`,
      );
    } else {
      stableBottomRounds = 0;
    }

    previousBottomFingerprint = fingerprint;

    if (stableBottomRounds >= config.automation.bottomStableRounds) {
      log(`SCAN_COMPLETE total_buyers=${seen.size}`);
      return [...seen];
    }
  }

  throw new Error(
    `COLLECTION_TIMEOUT: scan conversation list belum mencapai bottom stabil setelah ${config.automation.collectionTimeoutMs}ms`,
  );
}

async function findBuyerRowByExactName(
  page,
  targetName,
  config,
  searchHint = null,
) {
  const hasOrdinalHint =
    Number.isInteger(searchHint?.targetOrdinal) &&
    Number.isInteger(searchHint?.totalBuyers) &&
    searchHint.totalBuyers > 1;

  if (hasOrdinalHint) {
    const targetOrdinal = Math.max(
      0,
      Math.min(searchHint.totalBuyers - 1, searchHint.targetOrdinal),
    );
    const targetRatio = targetOrdinal / (searchHint.totalBuyers - 1);

    // Setelah buyer yang sudah diproses naik ke atas, buyer snapshot berikutnya
    // tetap berada kurang-lebih pada ordinal snapshot semula. Lompat langsung
    // ke posisi tersebut agar pencarian buyer ke-N tidak lagi O(N) dari top.
    await runOnConversationScroller(page, 'ratio', targetRatio);
    await sleep(page, config.automation.pollIntervalMs);

    const localSearchRounds = 8;
    for (let round = 0; round < localSearchRounds; round += 1) {
      await waitForListNotLoading(page, config);

      const pinned = await findPinnedBuyerRowInCurrentViewport(page, targetName);
      if (pinned) {
        if (round > 0) {
          log(
            `BUYER_FAST_SEEK target=${targetName} ordinal=${targetOrdinal + 1}/${searchHint.totalBuyers} corrections=${round}`,
          );
        } else {
          log(
            `BUYER_FAST_SEEK target=${targetName} ordinal=${targetOrdinal + 1}/${searchHint.totalBuyers} direct_hit=true`,
          );
        }
        return pinned;
      }

      const metrics = await runOnConversationScroller(page, 'read');
      const visibleRange = await getVisibleBuyerOrdinalRange(
        page,
        searchHint.buyerOrdinalByName,
      );

      let direction = 1;
      if (visibleRange) {
        if (targetOrdinal < visibleRange.min) direction = -1;
        if (targetOrdinal > visibleRange.max) direction = 1;
      }

      const step = Math.max(
        1,
        Math.floor(metrics.clientHeight * config.automation.scrollStepRatio),
      );
      await runOnConversationScroller(page, 'by', direction * step);
      await sleep(page, config.automation.pollIntervalMs);
    }

    log(
      `BUYER_FAST_SEEK_FALLBACK target=${targetName} ordinal=${targetOrdinal + 1}/${searchHint.totalBuyers}`,
    );
  }

  // Fallback konservatif bila ratio hint meleset karena reorder eksternal,
  // buyer baru masuk, atau layout list berubah.
  await runOnConversationScroller(page, 'top');
  await sleep(page, config.automation.pollIntervalMs);

  const deadline = Date.now() + config.automation.collectionTimeoutMs;
  let stableBottomRounds = 0;
  let previousFingerprint = '';

  while (Date.now() < deadline) {
    await waitForListNotLoading(page, config);

    const pinned = await findPinnedBuyerRowInCurrentViewport(page, targetName);
    if (pinned) return pinned;

    const metrics = await runOnConversationScroller(page, 'read');
    if (!metrics.atBottom) {
      stableBottomRounds = 0;
      previousFingerprint = '';
      const step = Math.max(
        1,
        Math.floor(metrics.clientHeight * config.automation.scrollStepRatio),
      );
      await runOnConversationScroller(page, 'by', step);
      await sleep(page, config.automation.pollIntervalMs);
      continue;
    }

    await runOnConversationScroller(page, 'bottom');
    await sleep(page, config.automation.bottomProbeIntervalMs);

    const state = await detectConversationListState(page);
    if (state.state === 'LIST_LOADING') {
      stableBottomRounds = 0;
      previousFingerprint = '';
      continue;
    }

    const afterMetrics = await runOnConversationScroller(page, 'read');
    const fingerprint = [
      Math.round(afterMetrics.scrollHeight),
      Math.round(afterMetrics.clientHeight),
      afterMetrics.atBottom,
    ].join('|');

    if (afterMetrics.atBottom && fingerprint === previousFingerprint) {
      stableBottomRounds += 1;
    } else {
      stableBottomRounds = 0;
    }
    previousFingerprint = fingerprint;

    if (stableBottomRounds >= config.automation.bottomStableRounds) {
      return null;
    }
  }

  throw new Error(`FIND_BUYER_TIMEOUT: ${targetName}`);
}

async function getActiveBuyerName(page) {
  return normalizeText(
    await page.locator(SELECTORS.activeBuyer).innerText().catch(() => ''),
  );
}

async function waitForHeaderTarget(
  page,
  targetName,
  config,
  timeoutMs = config.automation.stateTimeoutMs,
) {
  return waitUntil({
    page,
    timeoutMs,
    pollIntervalMs: config.automation.pollIntervalMs,
    label: `CHAT_HEADER[${targetName}]`,
    check: async () => {
      const current = await getActiveBuyerName(page);
      return {
        done: current === targetName,
        state: current === targetName ? 'HEADER_TARGET_CONFIRMED' : 'CHAT_SWITCHING',
      };
    },
  });
}

async function openBuyerByExactName(page, buyerName, config, searchHint = null) {
  const maxAttempts = 3;
  const headerAttemptTimeoutMs = Math.min(3000, config.automation.stateTimeoutMs);
  let lastActiveBuyer = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const rowHandle = await findBuyerRowByExactName(
      page,
      buyerName,
      config,
      searchHint,
    );
    if (!rowHandle) {
      throw new Error(`Buyer tidak ditemukan lagi di list: ${buyerName}`);
    }

    try {
      const pinnedName = normalizeText(
        await rowHandle
          .$eval(SELECTORS.buyerName, (element) => element.textContent ?? '')
          .catch(() => ''),
      );
      const box = await rowHandle.boundingBox().catch(() => null);

      if (pinnedName !== buyerName) {
        log(
          `BUYER_CLICK_RETRY target=${buyerName} attempt=${attempt}/${maxAttempts} reason=pinned_name_changed actual=${pinnedName}`,
        );
        continue;
      }

      log(
        `BUYER_CLICK target=${buyerName} attempt=${attempt}/${maxAttempts}` +
          (box ? ` x=${Math.round(box.x)} y=${Math.round(box.y)}` : ''),
      );

      await rowHandle.click({ timeout: config.automation.stateTimeoutMs });
    } catch (error) {
      log(
        `BUYER_CLICK_RETRY target=${buyerName} attempt=${attempt}/${maxAttempts} reason=${error?.message ?? error}`,
      );
      continue;
    } finally {
      await rowHandle.dispose().catch(() => {});
    }

    try {
      await waitForHeaderTarget(page, buyerName, config, headerAttemptTimeoutMs);
      return;
    } catch {
      lastActiveBuyer = await getActiveBuyerName(page);
      log(
        `BUYER_CLICK_NO_NAV target=${buyerName} attempt=${attempt}/${maxAttempts} active=${lastActiveBuyer || '<empty>'}`,
      );
    }
  }

  throw new Error(
    `OPEN_BUYER_FAILED target=${buyerName} active=${lastActiveBuyer || '<empty>'} attempts=${maxAttempts}`,
  );
}

async function detectHistoryState(page, targetName) {
  const currentName = await getActiveBuyerName(page);
  if (currentName !== targetName) {
    return { state: 'CHAT_SWITCHING', messageCount: 0 };
  }

  const history = page.locator(SELECTORS.history);
  if (!(await history.isVisible().catch(() => false))) {
    return { state: 'HISTORY_NOT_MOUNTED', messageCount: 0 };
  }

  const prompts = page.locator(SELECTORS.historyPrompt);
  if (await visibleLocatorWithText(prompts, 'Loading Failed')) {
    return { state: 'HISTORY_FAILED', messageCount: 0 };
  }
  if (await visibleLocatorWithText(prompts, 'Loading...')) {
    return { state: 'HISTORY_LOADING', messageCount: 0 };
  }

  const messageCount = await page.locator(SELECTORS.messages).count();
  if (messageCount > 0) {
    return { state: 'HISTORY_READY_DATA', messageCount };
  }

  if (await anyVisible(page.locator(SELECTORS.historyEmpty))) {
    return { state: 'HISTORY_READY_EMPTY', messageCount: 0 };
  }

  return { state: 'HISTORY_TRANSIENT_EMPTY', messageCount: 0 };
}

async function waitForHistoryReady(page, targetName, config) {
  const deadline = Date.now() + config.automation.stateTimeoutMs;
  let emptyStableRounds = 0;
  let lastState;

  while (Date.now() < deadline) {
    const current = await detectHistoryState(page, targetName);
    if (current.state !== lastState) {
      log(`CHAT_HISTORY[${targetName}]: ${current.state}`);
      lastState = current.state;
    }

    if (current.state === 'HISTORY_FAILED') {
      throw new Error(`History loading failed: ${targetName}`);
    }

    if (
      current.state === 'HISTORY_READY_DATA' ||
      current.state === 'HISTORY_READY_EMPTY'
    ) {
      return current;
    }

    if (current.state === 'HISTORY_TRANSIENT_EMPTY') {
      emptyStableRounds += 1;
      if (emptyStableRounds >= config.automation.historyEmptyStableRounds) {
        log(`CHAT_HISTORY[${targetName}]: HISTORY_READY_EMPTY_STABLE`);
        return { state: 'HISTORY_READY_EMPTY_STABLE', messageCount: 0 };
      }
    } else {
      emptyStableRounds = 0;
    }

    await sleep(page, config.automation.pollIntervalMs);
  }

  throw new Error(
    `CHAT_HISTORY[${targetName}]: TIMEOUT (state terakhir: ${lastState ?? 'unknown'})`,
  );
}

function composerLocator(page) {
  return page.getByPlaceholder('Press / to trigger quick reply').first();
}

async function resolveComposer(page) {
  const primary = composerLocator(page);
  if (await primary.isVisible().catch(() => false)) {
    return primary;
  }
  return page.locator(SELECTORS.composerFallback).first();
}

async function waitForComposerReady(page, targetName, config) {
  return waitUntil({
    page,
    timeoutMs: config.automation.stateTimeoutMs,
    pollIntervalMs: config.automation.pollIntervalMs,
    label: `COMPOSER[${targetName}]`,
    check: async () => {
      const currentName = await getActiveBuyerName(page);
      if (currentName !== targetName) {
        return { done: false, state: 'CHAT_SWITCHING' };
      }

      const composer = await resolveComposer(page);
      const send = page.locator(SELECTORS.sendButton).first();
      const composerVisible = await composer.isVisible().catch(() => false);
      const composerEnabled = await composer.isEnabled().catch(() => false);
      const sendVisible = await send.isVisible().catch(() => false);
      const sendEnabled = await send.isEnabled().catch(() => false);

      const ready = composerVisible && composerEnabled && sendVisible && sendEnabled;
      return {
        done: ready,
        state: ready ? 'COMPOSER_READY' : 'COMPOSER_PENDING',
        composer,
        send,
      };
    },
  });
}

async function waitForSendConfirmed({
  page,
  targetName,
  message,
  beforeCount,
  config,
}) {
  const expected = normalizeText(message);

  return waitUntil({
    page,
    timeoutMs: config.automation.stateTimeoutMs,
    pollIntervalMs: config.automation.pollIntervalMs,
    label: `SEND[${targetName}]`,
    check: async () => {
      const currentName = await getActiveBuyerName(page);
      if (currentName !== targetName) {
        throw new Error(
          `Active buyer berubah saat send. expected=${targetName} actual=${currentName}`,
        );
      }

      const outgoing = page.locator(SELECTORS.outgoingMessages);
      const count = await outgoing.count();
      if (count <= beforeCount) {
        return { done: false, state: 'SENDING_WAIT_NEW_OUTGOING' };
      }

      const from = Math.max(0, count - 3);
      for (let i = count - 1; i >= from; i -= 1) {
        const text = normalizeText(
          await outgoing.nth(i).innerText().catch(() => ''),
        );
        if (text.includes(expected)) {
          return { done: true, state: 'SEND_CONFIRMED', outgoingCount: count };
        }
      }

      return { done: false, state: 'SENDING_NEW_OUTGOING_TEXT_PENDING' };
    },
  });
}

async function sendOneMessage(
  page,
  targetName,
  message,
  config,
  { onBeforeSend, onConfirmed },
) {
  await waitForHeaderTarget(page, targetName, config);
  await waitForHistoryReady(page, targetName, config);
  const { composer, send } = await waitForComposerReady(page, targetName, config);

  await composer.fill(message);
  const actualValue = await composer.inputValue();
  if (actualValue !== message) {
    throw new Error(`MESSAGE_FILL_MISMATCH untuk ${targetName}`);
  }

  // Identity barrier tepat sebelum operasi yang memutasi state eksternal.
  await waitForHeaderTarget(page, targetName, config);

  const outgoing = page.locator(SELECTORS.outgoingMessages);
  const beforeCount = await outgoing.count();

  // Checkpoint dibuat tepat sebelum click. Jika proses mati setelah ini,
  // rerun akan fail-closed pada status pending agar tidak auto-send dua kali.
  onBeforeSend();
  await send.click();

  await waitForSendConfirmed({
    page,
    targetName,
    message,
    beforeCount,
    config,
  });

  onConfirmed();
}

async function processBuyer(page, buyerName, config, store, searchHint = null) {
  if (store.isBuyerComplete.get(buyerName)) {
    log(`SKIP buyer=${buyerName} reason=already_complete`);
    return { status: 'skipped' };
  }

  await openBuyerByExactName(page, buyerName, config, searchHint);

  for (let i = 0; i < config.chat.messages.length; i += 1) {
    const message = config.chat.messages[i];
    const identity = messageIdentity(i, message);
    const checkpoint = store.getMessageCheckpoint.get(buyerName, identity.key);

    if (checkpoint?.status === 'confirmed') {
      log(`SKIP buyer=${buyerName} message_index=${i} reason=checkpoint_exists`);
      continue;
    }

    if (checkpoint?.status === 'pending') {
      throw new Error(
        `UNRESOLVED_PENDING buyer=${buyerName} message_index=${i} claimed_at=${checkpoint.claimed_at}. ` +
          'Script tidak akan auto-send ulang karena pengiriman sebelumnya mungkin sudah terjadi. ' +
          'Periksa chat Duoke lalu hapus row pending dari SQLite hanya jika yakin pesan belum terkirim.',
      );
    }

    log(`SEND_START buyer=${buyerName} message_index=${i}`);
    await sendOneMessage(page, buyerName, message, config, {
      onBeforeSend: () => {
        store.claimMessage.run(
          buyerName,
          identity.key,
          i,
          identity.sha256,
          new Date().toISOString(),
        );
      },
      onConfirmed: () => {
        const result = store.confirmMessage.run(
          new Date().toISOString(),
          buyerName,
          identity.key,
        );
        if (result.changes !== 1) {
          throw new Error(
            `Gagal mengubah checkpoint menjadi confirmed untuk buyer=${buyerName} message_index=${i}`,
          );
        }
      },
    });

    log(`SEND_CHECKPOINT buyer=${buyerName} message_index=${i}`);

    if (i < config.chat.messages.length - 1) {
      await sleep(page, config.automation.betweenMessagesMs);
    }
  }

  store.markBuyerComplete.run(buyerName, new Date().toISOString());
  log(`BUYER_COMPLETE buyer=${buyerName}`);
  return { status: 'sent' };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = readConfig(args.config);
  const store = openDatabase(config.storage.sqlitePath);

  let context;
  try {
    context = await chromium.launchPersistentContext(config.duoke.profileDir, {
      headless: config.duoke.headless,
      viewport: { width: 1440, height: 1000 },
    });

    const pages = context.pages();
    const page = pages[0] ?? (await context.newPage());
    page.setDefaultTimeout(config.automation.stateTimeoutMs);

    log(`OPEN ${config.duoke.url}`);
    await page.goto(config.duoke.url, { waitUntil: 'domcontentloaded' });

    log('Menunggu sesi login + shell chat. Jika belum login, lakukan login di browser ini.');
    await waitForPageShell(page, config);
    await waitForConversationListReady(page, config);

    // Snapshot buyer dilakukan sebelum send supaya outgoing message tidak
    // mengubah urutan list dan membuat traversal kehilangan buyer.
    const buyers = await collectAllBuyerNames(page, config);
    const buyerOrdinalByName = new Map(
      buyers.map((buyerName, index) => [buyerName, index]),
    );
    log(`BUYER_SNAPSHOT total=${buyers.length}`);

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < buyers.length; i += 1) {
      const buyerName = buyers[i];
      log(`BUYER ${i + 1}/${buyers.length}: ${buyerName}`);

      try {
        const result = await processBuyer(page, buyerName, config, store, {
          targetOrdinal: i,
          totalBuyers: buyers.length,
          buyerOrdinalByName,
        });
        if (result.status === 'skipped') skipped += 1;
        if (result.status === 'sent') sent += 1;
      } catch (error) {
        failed += 1;
        console.error(
          `[${new Date().toISOString()}] BUYER_FAILED buyer=${buyerName}`,
          error,
        );
        // Continue buyer berikutnya. Buyer ini tidak ditandai complete;
        // message checkpoint yang sudah sukses tetap tersimpan agar rerun aman.
      }

      if (i < buyers.length - 1) {
        await sleep(page, config.automation.betweenBuyersMs);
      }
    }

    log(`DONE sent=${sent} skipped=${skipped} failed=${failed} total=${buyers.length}`);

    if (failed > 0) {
      process.exitCode = 2;
    }
  } finally {
    store.db.close();
    if (context) {
      await context.close();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
