const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Pool } = require('pg');
require('dotenv').config();

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const PREFIX = '$';
const useDatabase = process.env.DATABASE_URL ? true : false;
let pool;

if (useDatabase) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });
    console.log('✅ Using PostgreSQL');
} else {
    console.log('⚠️ No database, using memory');
}

// Auto-create the players table on startup — no manual SQL needed
async function initDatabase() {
    if (!useDatabase) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS players (
                user_id TEXT PRIMARY KEY,
                username TEXT,
                character_name TEXT,
                hp INTEGER, mp INTEGER, ip INTEGER,
                armor INTEGER, barrier INTEGER,
                max_hp INTEGER, max_mp INTEGER, max_ip INTEGER,
                max_armor INTEGER, max_barrier INTEGER,
                status_effects TEXT DEFAULT '[]',
                stats TEXT,
                image_url TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS stats TEXT`);
        await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS image_url TEXT`);
        console.log('✅ Players table ready');
    } catch (err) { console.error('DB init error:', err); }
}

const playerData = new Map();
const playerHistory = new Map(); // userId -> array of snapshots (max 5)

// FIX 1: channel-scoped encounters — keyed by channelId
const activeEncounters = new Map(); // channelId -> { active, combatants, turnsTaken, overdrive }

function getEncounter(channelId) {
    if (!activeEncounters.has(channelId)) {
        activeEncounters.set(channelId, {
            active: false,
            combatants: [],
            turnsTaken: new Set(),
            overdrive: 0,
            pets: [], // { ownerId, name, HP, MP, maxHP, maxMP }
            crisisTriggered: new Set() // userIds who hit first crisis this clash
        });
    }
    return activeEncounters.get(channelId);
}

// Class ability reference — edit classes.json to update, no code changes needed
let classData = {};
try {
    classData = require('./classes.json');
    console.log(`✅ Loaded ${Object.keys(classData).length} classes`);
} catch (err) {
    console.error('⚠️ classes.json not found — $class disabled');
}

// Cast reference — edit casts.json to update, no code changes needed
let castData = {};
try {
    castData = require('./casts.json');
    const n = Object.values(castData).reduce((a, s) => a + s.casts.length, 0);
    console.log(`✅ Loaded ${n} casts in ${Object.keys(castData).length} schools`);
} catch (err) {
    console.error('⚠️ casts.json not found — $cast disabled');
}

// Format one cast as an embed field
function castField(c) {
    const bits = [`${c.mp} MP`, c.target, c.duration];
    if (c.damage) bits.push(c.damage);
    let value = bits.join(' · ');
    if (c.require) value += `\n*Requires: ${c.require}*`;
    value += `\n${c.effect}`;
    return { name: `${c.offensive ? '🪄 ' : ''}${c.name} (${c.ap})`, value, inline: false };
}

const EMOJIS = { HP: '❤️', MP: '💧', IP: '💰', Armor: '🛡️', Barrier: '✨', Overdrive: '⚡' };
const MAX_OVERDRIVE = 12;
const MAX_HISTORY = 5;

function initPlayer(userId, username) {
    if (!playerData.has(userId)) {
        playerData.set(userId, {
            username, characterName: username,
            HP: 100, MP: 50, IP: 100, Armor: 0, Barrier: 0,
            maxHP: 100, maxMP: 50, maxIP: 100, maxArmor: 20, maxBarrier: 15
        });
    }
}

// Save a snapshot of a player's current state before mutating
function saveSnapshot(userId) {
    const d = playerData.get(userId);
    if (!d) return;
    if (!playerHistory.has(userId)) playerHistory.set(userId, []);
    const history = playerHistory.get(userId);
    history.push({ ...d });
    if (history.length > MAX_HISTORY) history.shift();
}

// Restore the most recent snapshot
function popSnapshot(userId) {
    const history = playerHistory.get(userId);
    if (!history || history.length === 0) return null;
    return history.pop();
}

async function loadPlayerFromDB(userId) {
    if (!useDatabase) return null;
    try {
        const result = await pool.query('SELECT * FROM players WHERE user_id = $1', [userId]);
        if (result.rows.length > 0) {
            const r = result.rows[0];
            let stats = null;
            try { if (r.stats) stats = JSON.parse(r.stats); } catch (e) {}
            return {
                username: r.username, characterName: r.character_name,
                HP: Math.min(r.hp ?? r.max_hp, r.max_hp),
                MP: Math.min(r.mp ?? r.max_mp, r.max_mp),
                IP: Math.min(r.ip ?? r.max_ip, r.max_ip),
                Armor: 0, Barrier: 0, // round-scoped, always reset
                maxHP: r.max_hp, maxMP: r.max_mp, maxIP: r.max_ip, maxArmor: r.max_armor, maxBarrier: r.max_barrier,
                stats,
                imageUrl: r.image_url || null
            };
        }
    } catch (err) { console.error('Load error:', err); }
    return null;
}

async function saveCharacterSheet(userId, data) {
    if (!useDatabase) return;
    try {
        await pool.query(`
            INSERT INTO players (user_id, username, character_name, hp, mp, ip, armor, barrier, max_hp, max_mp, max_ip, max_armor, max_barrier, status_effects, stats, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id) DO UPDATE SET
                username = $2, character_name = $3, max_hp = $9, max_mp = $10, max_ip = $11, max_armor = $12, max_barrier = $13, stats = $15, updated_at = CURRENT_TIMESTAMP
        `, [userId, data.username, data.characterName, data.maxHP, data.maxMP, data.maxIP, 0, 0, data.maxHP, data.maxMP, data.maxIP, data.maxArmor, data.maxBarrier, '[]', data.stats ? JSON.stringify(data.stats) : null]);
    } catch (err) { console.error('Save error:', err); }
}

// Persist current HP/MP/IP so live values survive redeploys (fire-and-forget)
async function savePlayerState(userId) {
    if (!useDatabase) return;
    const d = playerData.get(userId);
    if (!d) return;
    try {
        await pool.query(
            'UPDATE players SET hp = $2, mp = $3, ip = $4, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1',
            [userId, d.HP, d.MP, d.IP]
        );
    } catch (err) { console.error('State save error:', err); }
}

// Persist character image so thumbnails survive redeploys
async function savePlayerImage(userId, url) {
    if (!useDatabase) return;
    try {
        await pool.query(
            'UPDATE players SET image_url = $2, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1',
            [userId, url]
        );
    } catch (err) { console.error('Image save error:', err); }
}

// ========================================
// CRISIS HELPERS
// Crisis = HP at or below half of max HP, rounded down (49 max -> threshold 24)
// ========================================
function crisisThreshold(d) { return Math.floor(d.maxHP / 2); }
function inCrisis(d) { return d.HP <= crisisThreshold(d); }
function crisisTag(d) { return inCrisis(d) ? ' **(crisis)**' : ''; }

// First crisis per PC per clash prompts +1 Overdrive (notice only, not auto-added)
function checkFirstCrisis(channelId, userId, d) {
    const encounter = activeEncounters.get(channelId);
    if (!encounter || !encounter.active) return null;
    if (!encounter.combatants.includes(userId)) return null;
    if (!encounter.crisisTriggered) encounter.crisisTriggered = new Set();
    if (!inCrisis(d)) return null;
    if (encounter.crisisTriggered.has(userId)) return null;
    encounter.crisisTriggered.add(userId);
    return `⚡ **First crisis this Clash** — the party gains **1 Overdrive**! (\`$od +1\`)`;
}

// ========================================
// ATTRIBUTE STAT HELPERS
// Stats are die sizes (d6–d12). Up/down shift by one size (±2), clamped 6–12.
// Buffs live in memory only (scene-scoped) — base stats are what persists.
// ========================================
const STAT_KEYS = { f: 'force', m: 'mind', g: 'grace', s: 'soul', h: 'heart' };
const STAT_MIN = 6, STAT_MAX = 12;

function effectiveStat(d, key) {
    if (!d.stats || !d.stats[key]) return null;
    const mod = (d.statMods && d.statMods[key]) || 0;
    return Math.max(STAT_MIN, Math.min(STAT_MAX, d.stats[key] + mod));
}

function statArrow(d, key) {
    const mod = (d.statMods && d.statMods[key]) || 0;
    return mod > 0 ? '🔼' : mod < 0 ? '🔻' : '';
}

// Resolve a dice token: stat letter (f/m/g/s/h) -> effective stat die, otherwise plain number
function resolveDie(token, d) {
    if (!token) return NaN;
    const t = token.toLowerCase();
    if (STAT_KEYS[t]) {
        const v = effectiveStat(d, STAT_KEYS[t]);
        return v || NaN;
    }
    return parseInt(token);
}

// Label prefix for dice display when a stat letter was used ('F ' / 'G🔼 ' / '')
function dieLabel(token, d) {
    if (token && STAT_KEYS[token.toLowerCase()]) {
        return token.toUpperCase() + statArrow(d, STAT_KEYS[token.toLowerCase()]) + ' ';
    }
    return '';
}

// Memory first, then DB, then fresh defaults — replaces bare initPlayer in commands
async function ensurePlayer(userId, username) {
    if (playerData.has(userId)) return playerData.get(userId);
    const dbData = await loadPlayerFromDB(userId);
    if (dbData) {
        playerData.set(userId, dbData);
        return dbData;
    }
    initPlayer(userId, username);
    return playerData.get(userId);
}

// Memory then DB, but never creates defaults — for commands that should error if no character exists
async function tryLoadPlayer(userId) {
    if (playerData.has(userId)) return true;
    const dbData = await loadPlayerFromDB(userId);
    if (dbData) { playerData.set(userId, dbData); return true; }
    return false;
}

// ========================================
// GOOGLE SHEETS IMPORT FUNCTIONS
// ========================================

function parseSheetUrl(url) {
    const spreadsheetMatch = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
    const gidMatch = url.match(/[#&?]gid=([0-9]+)/);
    if (!spreadsheetMatch) return null;
    return { spreadsheetId: spreadsheetMatch[1], gid: gidMatch ? gidMatch[1] : '0' };
}

async function fetchSheetData(spreadsheetId, gid) {
    try {
        let url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
        let response = await fetch(url);
        
        if (!response.ok && gid === '0') {
            url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv`;
            response = await fetch(url);
        }
        
        if (!response.ok) {
            url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&gid=${gid}`;
            response = await fetch(url);
        }
        
        if (!response.ok) throw new Error('Sheet not accessible');
        const csvText = await response.text();
        
        if (csvText.includes('<!DOCTYPE') || csvText.includes('<html')) {
            throw new Error('Sheet requires authentication');
        }
        
        return parseCSV(csvText);
    } catch (error) {
        console.error('Error fetching sheet:', error);
        return null;
    }
}

function parseCSV(csvText) {
    const lines = csvText.split('\n');
    const data = [];
    for (const line of lines) {
        const row = line.split(',').map(cell => cell.trim().replace(/^"|"$/g, ''));
        data.push(row);
    }
    return data;
}

function cellToIndex(cell) {
    const match = cell.match(/^([A-Z]+)(\d+)$/);
    if (!match) return null;
    const col = match[1];
    const row = parseInt(match[2]);
    let colIndex = 0;
    for (let i = 0; i < col.length; i++) {
        colIndex = colIndex * 26 + (col.charCodeAt(i) - 65 + 1);
    }
    colIndex -= 1;
    return { row: row - 1, col: colIndex };
}

function getCellValue(data, cellRef) {
    const pos = cellToIndex(cellRef);
    if (!pos || !data[pos.row]) return null;
    const value = data[pos.row][pos.col];
    return value || null;
}

function parseDiceValue(value) {
    if (!value) return 0;
    const str = String(value).toLowerCase();
    const match = str.match(/d(\d+)/);
    if (match) return parseInt(match[1]);
    const num = parseInt(str);
    return isNaN(num) ? 0 : num;
}

async function extractCharacterFromSheet(sheetUrl) {
    const parsed = parseSheetUrl(sheetUrl);
    if (!parsed) return { error: 'Invalid Google Sheets URL' };
    
    const data = await fetchSheetData(parsed.spreadsheetId, parsed.gid);
    if (!data) return { error: 'Could not fetch sheet. Make sure it\'s public (Anyone with link can view)' };
    
    try {
        const maxHP = (parseInt(getCellValue(data, 'Q15')) || 0) + (parseInt(getCellValue(data, 'Q17')) || 0);
        const maxMP = (parseInt(getCellValue(data, 'Q18')) || 0) + (parseInt(getCellValue(data, 'Q20')) || 0);
        const maxIP = (parseInt(getCellValue(data, 'Q21')) || 0) + (parseInt(getCellValue(data, 'Q23')) || 0);

        const armorA = parseInt(getCellValue(data, 'AA15')) || 0;
        const armorB = parseInt(getCellValue(data, 'AA17')) || 0;
        const maxArmor = armorA + armorB || 0;

        const barrierA = parseInt(getCellValue(data, 'AA18')) || 0;
        const barrierB = parseInt(getCellValue(data, 'AA20')) || 0;
        const maxBarrier = barrierA + barrierB || 0;
        
        const force = parseDiceValue(getCellValue(data, 'S26'));
        const mind = parseDiceValue(getCellValue(data, 'S28'));
        const grace = parseDiceValue(getCellValue(data, 'S30'));
        const soul = parseDiceValue(getCellValue(data, 'S32'));
        const heart = parseDiceValue(getCellValue(data, 'S34'));
        
        const characterName = getCellValue(data, 'E2') || getCellValue(data, 'F2') || getCellValue(data, 'E3') || getCellValue(data, 'F3') || 'Character';
        
        return { characterName, maxHP, maxMP, maxIP, maxArmor, maxBarrier, stats: { force, mind, grace, soul, heart } };
    } catch (error) {
        console.error('Error extracting character:', error);
        return { error: 'Error reading character data from sheet' };
    }
}

// ========================================
// DAMAGE CASCADE HELPER
// ========================================

function applyDamageCascade(d, dmg, dmgType) {
    const oldArmor = d.Armor, oldBarrier = d.Barrier, oldHP = d.HP;
    const lines = [];

    if (dmgType === 'armor') {
        if (d.Armor > 0) {
            const absorbed = Math.min(d.Armor, dmg);
            const overflow = dmg - absorbed;
            d.Armor = Math.max(0, d.Armor - dmg);
            lines.push(`${EMOJIS.Armor} Armor: **${oldArmor}** → **${d.Armor}** (absorbed ${absorbed})`);
            if (overflow > 0) {
                d.HP = Math.max(0, d.HP - overflow);
                lines.push(`${EMOJIS.HP} HP overflow: **${oldHP}** → **${d.HP}** (−${overflow})${crisisTag(d)}`);
            }
        } else {
            d.HP = Math.max(0, d.HP - dmg);
            lines.push(`${EMOJIS.Armor} No Armor — hit HP directly`);
            lines.push(`${EMOJIS.HP} HP: **${oldHP}** → **${d.HP}** (−${dmg})${crisisTag(d)}`);
        }
    } else if (dmgType === 'barrier') {
        if (d.Barrier > 0) {
            const absorbed = Math.min(d.Barrier, dmg);
            const overflow = dmg - absorbed;
            d.Barrier = Math.max(0, d.Barrier - dmg);
            lines.push(`${EMOJIS.Barrier} Barrier: **${oldBarrier}** → **${d.Barrier}** (absorbed ${absorbed})`);
            if (overflow > 0) {
                d.HP = Math.max(0, d.HP - overflow);
                lines.push(`${EMOJIS.HP} HP overflow: **${oldHP}** → **${d.HP}** (−${overflow})${crisisTag(d)}`);
            }
        } else {
            d.HP = Math.max(0, d.HP - dmg);
            lines.push(`${EMOJIS.Barrier} No Barrier — hit HP directly`);
            lines.push(`${EMOJIS.HP} HP: **${oldHP}** → **${d.HP}** (−${dmg})${crisisTag(d)}`);
        }
    } else {
        d.HP = Math.max(0, d.HP - dmg);
        lines.push(`💀 True damage bypasses defenses`);
        lines.push(`${EMOJIS.HP} HP: **${oldHP}** → **${d.HP}** (−${dmg})${crisisTag(d)}`);
    }

    return lines;
}

// ========================================
// OVERDRIVE BAR HELPER
// ========================================
function buildOverdriveBar(current) {
    return EMOJIS.Overdrive.repeat(current) || '—';
}

// ========================================

client.on('ready', async () => {
    console.log(`✅ ${client.user.tag}`);
    console.log(`✅ Prefix: ${PREFIX}`);
    await initDatabase();
});

client.on('messageCreate', async message => {
    if (message.author.bot || !message.content.startsWith(PREFIX)) return;
    
    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = args.shift().toLowerCase();
    const channelId = message.channel.id;
    
    const del = async () => { try { await message.delete(); } catch (e) {} };
    
    try {
        // $set
        if (cmd === 'set') {
            const user = message.mentions.users.first() || message.author;
            const member = await message.guild.members.fetch(user.id);
            const offset = message.mentions.users.first() ? 1 : 0;
            
            const firstArg = args[offset];
            if (firstArg && firstArg.includes('docs.google.com')) {
                await message.channel.send('📥 Importing character from Google Sheets...');
                
                const result = await extractCharacterFromSheet(firstArg);
                
                if (result.error) {
                    await message.channel.send(`❌ ${result.error}\n\n**Make sure:**\n- Sheet is public (Share → Anyone with link can view)\n- URL is correct`);
                    await del();
                    return;
                }
                
                playerData.set(user.id, {
                    username: member.displayName,
                    characterName: result.characterName,
                    HP: result.maxHP, MP: result.maxMP, IP: result.maxIP,
                    Armor: 0, Barrier: 0,
                    maxHP: result.maxHP, maxMP: result.maxMP, maxIP: result.maxIP,
                    maxArmor: result.maxArmor, maxBarrier: result.maxBarrier,
                    stats: result.stats
                });
                
                await saveCharacterSheet(user.id, playerData.get(user.id));
                
                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle(`✨ ${result.characterName}`)
                    .setDescription('**Imported from Google Sheets!**')
                    .addFields(
                        { name: `${EMOJIS.HP} HP`, value: `${result.maxHP}/${result.maxHP}`, inline: true },
                        { name: `${EMOJIS.MP} MP`, value: `${result.maxMP}/${result.maxMP}`, inline: true },
                        { name: `${EMOJIS.IP} IP`, value: `${result.maxIP}/${result.maxIP}`, inline: true },
                        { name: `${EMOJIS.Armor} Armor`, value: `0/${result.maxArmor}`, inline: true },
                        { name: `${EMOJIS.Barrier} Barrier`, value: `0/${result.maxBarrier}`, inline: true },
                        { name: '📊 Base Stats', value: `FORCE: ${result.stats.force} | MIND: ${result.stats.mind} | GRACE: ${result.stats.grace}\nSOUL: ${result.stats.soul} | HEART: ${result.stats.heart}`, inline: false }
                    )
                    .setFooter({ text: 'Imported from Google Sheets' });
                
                await message.channel.send({ embeds: [embed] });
                await del();
                return;
            }
            
            if (args.length < 6 + offset) {
                await message.channel.send('Usage: `$set <n> <hp> <mp> <ip> <armor> <barrier>` or `$set <sheet_url>`\nExample: `$set Gandalf 100 50 100 20 15`');
                await del();
                return;
            }
            
            const [name, hp, mp, ip, armor, barrier] = [args[offset], parseInt(args[offset+1]), parseInt(args[offset+2]), parseInt(args[offset+3]), parseInt(args[offset+4]), parseInt(args[offset+5])];
            
            if (isNaN(hp) || isNaN(mp) || isNaN(ip) || isNaN(armor) || isNaN(barrier)) {
                await message.channel.send('❌ All stats must be numbers!');
                await del();
                return;
            }
            
            playerData.set(user.id, {
                username: member.displayName, characterName: name,
                HP: hp, MP: mp, IP: ip, Armor: 0, Barrier: 0,
                maxHP: hp, maxMP: mp, maxIP: ip, maxArmor: armor, maxBarrier: barrier
            });
            
            await saveCharacterSheet(user.id, playerData.get(user.id));
            
            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle(`✨ ${name}`)
                .addFields(
                    { name: `${EMOJIS.HP} HP`, value: `${hp}/${hp}`, inline: true },
                    { name: `${EMOJIS.MP} MP`, value: `${mp}/${mp}`, inline: true },
                    { name: `${EMOJIS.IP} IP`, value: `${ip}/${ip}`, inline: true },
                    { name: `${EMOJIS.Armor} Armor`, value: `0/${armor}`, inline: true },
                    { name: `${EMOJIS.Barrier} Barrier`, value: `0/${barrier}`, inline: true }
                )
                .setFooter({ text: 'HP/MP/IP full • Armor/Barrier 0' });
            
            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }
        
        // $view
        if (cmd === 'view') {
            const user = message.mentions.users.first() || message.author;
            const member = await message.guild.members.fetch(user.id);

            if (!(await tryLoadPlayer(user.id))) {
                await message.channel.send(`❌ No character set for **${member.displayName}**. Use \`$set\` first.`);
                await del();
                return;
            }

            const d = playerData.get(user.id);
            
            const embed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle(`${d.characterName}${inCrisis(d) ? ' (crisis)' : ''}`)
                .setThumbnail(d.imageUrl || null)
                .addFields(
                    { name: `${EMOJIS.HP} HP`, value: `${d.HP}/${d.maxHP}${crisisTag(d)}`, inline: true },
                    { name: `${EMOJIS.MP} MP`, value: `${d.MP}/${d.maxMP}`, inline: true },
                    { name: `${EMOJIS.IP} IP`, value: `${d.IP}/${d.maxIP}`, inline: true },
                    { name: `${EMOJIS.Armor} Armor`, value: `${d.Armor}/${d.maxArmor}`, inline: true },
                    { name: `${EMOJIS.Barrier} Barrier`, value: `${d.Barrier}/${d.maxBarrier}`, inline: true }
                );

            if (d.stats) {
                const sv = (k) => `${effectiveStat(d, k)}${statArrow(d, k)}`;
                embed.addFields({ name: '📊 Stats', value: `FORCE: ${sv('force')} | MIND: ${sv('mind')} | GRACE: ${sv('grace')}\nSOUL: ${sv('soul')} | HEART: ${sv('heart')}`, inline: false });
            }
            
            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }

        // FIX 4: $undo — restore previous state
        if (cmd === 'undo') {
            const userId = message.author.id;

            if (!(await tryLoadPlayer(userId))) {
                await message.channel.send('❌ No character found. Use `$set` first.');
                await del();
                return;
            }

            const snapshot = popSnapshot(userId);
            if (!snapshot) {
                await message.channel.send('❌ Nothing to undo.');
                await del();
                return;
            }

            const before = { ...playerData.get(userId) };
            playerData.set(userId, snapshot);
            savePlayerState(userId);
            const d = playerData.get(userId);

            const embed = new EmbedBuilder()
                .setColor(0xAAAAAA)
                .setTitle(`↩️ ${d.characterName} — Undone`)
                .addFields(
                    { name: `${EMOJIS.HP} HP`, value: `${before.HP} → **${d.HP}**/${d.maxHP}`, inline: true },
                    { name: `${EMOJIS.MP} MP`, value: `${before.MP} → **${d.MP}**/${d.maxMP}`, inline: true },
                    { name: `${EMOJIS.IP} IP`, value: `${before.IP} → **${d.IP}**/${d.maxIP}`, inline: true },
                    { name: `${EMOJIS.Armor} Armor`, value: `${before.Armor} → **${d.Armor}**/${d.maxArmor}`, inline: true },
                    { name: `${EMOJIS.Barrier} Barrier`, value: `${before.Barrier} → **${d.Barrier}**/${d.maxBarrier}`, inline: true }
                )
                .setFooter({ text: `Up to ${MAX_HISTORY} undos available` });

            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }

        // $dmg <amount> [a|b|t] [slot#...]
        // No slots = target self; slots = target clash positions
        if (cmd === 'dmg') {
            if (!args[0] || isNaN(parseInt(args[0]))) {
                await message.channel.send('Usage: `$dmg <amount> [a|b|t] [slot#...]`\n`a`=armor (default), `b`=barrier, `t`=true\nExample: `$dmg 20 a 1 3` or `$dmg 15 b` (targets self)');
                await del();
                return;
            }

            const dmg = parseInt(args[0]);
            const typeLabelFn = (t) => t === 'armor' ? 'Armor' : t === 'barrier' ? 'Barrier' : 'True';

            let dmgType = 'armor';
            let slotArgs = args.slice(1);
            if (slotArgs.length > 0 && ['a','b','t'].includes(slotArgs[0].toLowerCase())) {
                const flag = slotArgs.shift().toLowerCase();
                if (flag === 'b') dmgType = 'barrier';
                else if (flag === 't') dmgType = 'true';
            }

            const slots = slotArgs.map(s => parseInt(s)).filter(n => !isNaN(n));
            const petSlots = slotArgs
                .filter(s => /^[a-z]$/i.test(s) && isNaN(parseInt(s)))
                .map(s => s.toLowerCase().charCodeAt(0) - 97);

            if (slots.length === 0 && petSlots.length === 0) {
                const userId = message.author.id;
                if (!(await tryLoadPlayer(userId))) {
                    await message.channel.send('❌ No character found. Use `$set` first.');
                    await del();
                    return;
                }
                saveSnapshot(userId);
                const d = playerData.get(userId);
                const cascadeLines = applyDamageCascade(d, dmg, dmgType);
                savePlayerState(userId);
                const crisisNotice = checkFirstCrisis(channelId, userId, d);
                if (crisisNotice) cascadeLines.push(crisisNotice);
                const embed = new EmbedBuilder()
                    .setColor(0xFF6B6B)
                    .setTitle(`💔 ${d.characterName} — ${dmg} ${typeLabelFn(dmgType)} Damage`)
                    .setDescription(cascadeLines.join('\n'));
                if (d.HP === 0) embed.setFooter({ text: '💀 HP reached 0!' });
                await message.channel.send({ embeds: [embed] });
                await del();
                return;
            }

            const encounter = getEncounter(channelId);
            if (!encounter.active) {
                await message.channel.send('❌ No active clash in this channel. Omit slot numbers to target yourself.');
                await del();
                return;
            }

            const errors = [];
            const embedObjects = [];
            for (const slot of slots) {
                const idx = slot - 1;
                if (idx < 0 || idx >= encounter.combatants.length) {
                    errors.push(`❌ No combatant in slot **${slot}**.`);
                    continue;
                }
                const targetId = encounter.combatants[idx];
                if (!playerData.has(targetId)) {
                    errors.push(`❌ Slot **${slot}** has no character data.`);
                    continue;
                }
                saveSnapshot(targetId);
                const d = playerData.get(targetId);
                const cascadeLines = applyDamageCascade(d, dmg, dmgType);
                savePlayerState(targetId);
                const crisisNotice = checkFirstCrisis(channelId, targetId, d);
                if (crisisNotice) cascadeLines.push(crisisNotice);
                const embed = new EmbedBuilder()
                    .setColor(0xFF6B6B)
                    .setTitle(`💔 ${slot}. ${d.characterName} — ${dmg} ${typeLabelFn(dmgType)} Damage`)
                    .setDescription(cascadeLines.join('\n'));
                if (d.HP === 0) embed.setFooter({ text: '💀 HP reached 0!' });
                embedObjects.push(embed);
            }

            // Pet targets — no Armor/Barrier, all damage hits HP directly
            const pets = encounter.pets || [];
            for (const idx of petSlots) {
                const letter = String.fromCharCode(97 + idx);
                if (idx < 0 || idx >= pets.length) {
                    errors.push(`❌ No pet in slot **${letter}**.`);
                    continue;
                }
                const pet = pets[idx];
                const oldHP = pet.HP;
                pet.HP = Math.max(0, pet.HP - dmg);
                const embed = new EmbedBuilder()
                    .setColor(0xFF6B6B)
                    .setTitle(`💔 ${letter}. ${pet.name} — ${dmg} Damage`)
                    .setDescription(`🐾 Pets have no Armor/Barrier — hits HP directly\n${EMOJIS.HP} HP: **${oldHP}** → **${pet.HP}** (−${dmg})`);
                if (pet.HP === 0) embed.setFooter({ text: '💀 HP reached 0!' });
                embedObjects.push(embed);
            }

            if (errors.length > 0) await message.channel.send(errors.join('\n'));
            if (embedObjects.length > 0) await message.channel.send({ embeds: embedObjects });
            await del();
            return;
        }

        // $image
        if (cmd === 'image') {
            const userId = message.author.id;
            await ensurePlayer(userId, message.member.displayName);
            const d = playerData.get(userId);

            if (!args[0]) {
                d.imageUrl = null;
                savePlayerImage(userId, null);
                await message.channel.send(`🖼️ **${d.characterName}**'s image cleared.`);
                await del();
                return;
            }

            d.imageUrl = args[0];
            savePlayerImage(userId, args[0]);

            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle(`🖼️ ${d.characterName}`)
                .setDescription('Image set!')
                .setImage(args[0]);

            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }

        // $r <d1> <d2> [mod] — simple roll: sum of both dice + mod
        if (cmd === 'r' || cmd === 'roll') {
            if (args.length < 2) {
                await message.channel.send('Usage: `$r <d1|stat> <d2|stat> [mod]`\nStats: `f m g s h` (needs imported sheet)\nExample: `$r 6 6 2` = 2d6+2 · `$r f g 3`');
                await del();
                return;
            }

            const userId = message.author.id;
            const data = await ensurePlayer(userId, message.member.displayName);

            const d1 = resolveDie(args[0], data);
            const d2 = resolveDie(args[1], data);
            const mod = args[2] !== undefined ? parseInt(args[2]) : 0;

            if (isNaN(d1) || isNaN(d2) || isNaN(mod) || d1 < 1 || d2 < 1) {
                await message.channel.send('❌ Dice must be numbers or stat letters (`f m g s h` — stat letters need an imported sheet with `$set <url>`).');
                await del();
                return;
            }

            const r1 = Math.floor(Math.random() * d1) + 1;
            const r2 = Math.floor(Math.random() * d2) + 1;
            const total = r1 + r2 + mod;

            const fumble = r1 === 1 && r2 === 1;
            const crit = !fumble && r1 === r2 && r1 >= 6;

            const embed = new EmbedBuilder()
                .setColor(fumble ? 0x800000 : crit ? 0xFFD700 : 0x00BFFF)
                .setTitle(`🎲 ${data.characterName}'s Roll`)
                .setThumbnail(data.imageUrl || null)
                .addFields(
                    { name: 'Dice', value: `${dieLabel(args[0], data)}d${d1}: **${r1}** | ${dieLabel(args[1], data)}d${d2}: **${r2}**`, inline: false },
                    { name: 'Total', value: `${r1} + ${r2}${mod !== 0 ? ` + ${mod}` : ''} = **${total}**`, inline: false }
                );

            if (fumble) embed.setDescription('💀 **FUMBLE!**');
            else if (crit) embed.setDescription('⭐ **CRITICAL!**');

            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }

        // $a <d1> <d2> [mod] [gate] — mod defaults 0, gate defaults 1
        // NEW GATE RULE: miss only if BOTH dice roll at or below gate
        if (cmd === 'a' || cmd === 'attack') {
            if (args.length < 2) {
                await message.channel.send('Usage: `$a <d1|stat> <d2|stat> [mod] [gate]`\nStats: `f m g s h` (needs imported sheet)\nDefaults: mod=0, gate=1\nExample: `$a f g 5 2`');
                await del();
                return;
            }

            const userId = message.author.id;
            const data = await ensurePlayer(userId, message.member.displayName);

            const d1 = resolveDie(args[0], data);
            const d2 = resolveDie(args[1], data);
            const mod = args[2] !== undefined ? parseInt(args[2]) : 0;
            const gate = args[3] !== undefined ? parseInt(args[3]) : 1;

            if (isNaN(d1) || isNaN(d2) || isNaN(mod) || isNaN(gate)) {
                await message.channel.send('❌ Dice must be numbers or stat letters (`f m g s h` — stat letters need an imported sheet with `$set <url>`).');
                await del();
                return;
            }
            
            const r1 = Math.floor(Math.random() * d1) + 1;
            const r2 = Math.floor(Math.random() * d2) + 1;
            const hr = Math.max(r1, r2);
            const dmg = hr + mod;
            
            const fumble = r1 === 1 && r2 === 1;
            const crit = !fumble && r1 === r2 && r1 >= 6;
            const hit = fumble ? false : crit ? true : !(r1 <= gate && r2 <= gate);
            
            const embed = new EmbedBuilder()
                .setColor(fumble ? 0x800000 : crit ? 0xFFD700 : hit ? 0x00FF00 : 0xFF0000)
                .setTitle(`🎲 ${data.characterName}'s Attack`)
                .setThumbnail(data.imageUrl || null)
                .addFields(
                    { name: 'Dice', value: `${dieLabel(args[0], data)}d${d1}: **${r1}** | ${dieLabel(args[1], data)}d${d2}: **${r2}** = **${r1 + r2}**\nGate: **${gate}** (miss if both ≤**${gate}**)`, inline: false },
                    { name: 'Damage', value: `HR = **${hr}**\n${hr} + ${mod} = **${dmg}**`, inline: false }
                );
            
            if (fumble) embed.setDescription('💀 **FUMBLE!**');
            else if (crit) embed.setDescription('⭐ **CRITICAL!**');
            else if (hit) embed.setDescription('✅ **HIT!**');
            else embed.setDescription('❌ **MISS**');
            
            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }
        
        // $hp
        if (cmd === 'hp') {
            if (!args[0]) { await message.channel.send('Usage: `$hp <±amount|full|zero>`'); await del(); return; }
            const userId = message.author.id;
            await ensurePlayer(userId, message.member.displayName);
            saveSnapshot(userId);
            const d = playerData.get(userId);
            const old = d.HP;
            
            if (args[0] === 'full') d.HP = d.maxHP;
            else if (args[0] === 'zero') d.HP = 0;
            else d.HP = Math.max(0, d.HP + parseInt(args[0]));
            savePlayerState(userId);

            const embed = new EmbedBuilder()
                .setColor(d.HP > old ? 0x00FF00 : 0xFF6B6B)
                .setTitle(d.characterName)
                .addFields({ name: `${EMOJIS.HP} HP`, value: `${old} → **${d.HP}**/${d.maxHP}${crisisTag(d)}`, inline: true });

            const crisisNotice = checkFirstCrisis(channelId, userId, d);
            if (crisisNotice) embed.setDescription(crisisNotice);
            
            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }
        
        // $mp
        if (cmd === 'mp') {
            if (!args[0]) { await message.channel.send('Usage: `$mp <±amount|full|zero>`'); await del(); return; }
            const userId = message.author.id;
            await ensurePlayer(userId, message.member.displayName);
            saveSnapshot(userId);
            const d = playerData.get(userId);
            const old = d.MP;
            
            if (args[0] === 'full') d.MP = d.maxMP;
            else if (args[0] === 'zero') d.MP = 0;
            else d.MP = Math.max(0, d.MP + parseInt(args[0]));
            savePlayerState(userId);
            
            const embed = new EmbedBuilder()
                .setColor(d.MP > old ? 0x00FF00 : 0xFF6B6B)
                .setTitle(d.characterName)
                .addFields({ name: `${EMOJIS.MP} MP`, value: `${old} → **${d.MP}**/${d.maxMP}`, inline: true });
            
            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }
        
        // $ip
        if (cmd === 'ip') {
            if (!args[0]) { await message.channel.send('Usage: `$ip <±amount|full|zero>`'); await del(); return; }
            const userId = message.author.id;
            await ensurePlayer(userId, message.member.displayName);
            saveSnapshot(userId);
            const d = playerData.get(userId);
            const old = d.IP;
            
            if (args[0] === 'full') d.IP = d.maxIP;
            else if (args[0] === 'zero') d.IP = 0;
            else d.IP = Math.max(0, d.IP + parseInt(args[0]));
            savePlayerState(userId);
            
            const embed = new EmbedBuilder()
                .setColor(d.IP > old ? 0x00FF00 : 0xFF6B6B)
                .setTitle(d.characterName)
                .addFields({ name: `${EMOJIS.IP} IP`, value: `${old} → **${d.IP}**/${d.maxIP}`, inline: true });
            
            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }
        
        // $armor
        if (cmd === 'armor') {
            if (!args[0]) { await message.channel.send('Usage: `$armor <amount|full|zero>`'); await del(); return; }
            const userId = message.author.id;
            await ensurePlayer(userId, message.member.displayName);
            saveSnapshot(userId);
            const d = playerData.get(userId);
            const old = d.Armor;
            
            if (args[0] === 'full') d.Armor = d.maxArmor;
            else if (args[0] === 'zero') d.Armor = 0;
            else d.Armor = Math.max(0, d.Armor + parseInt(args[0]));
            
            const embed = new EmbedBuilder()
                .setColor(d.Armor > old ? 0x00FF00 : 0xFF6B6B)
                .setTitle(d.characterName)
                .addFields({ name: `${EMOJIS.Armor} Armor`, value: `${old} → **${d.Armor}**/${d.maxArmor}`, inline: true });
            
            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }
        
        // $barrier
        if (cmd === 'barrier') {
            if (!args[0]) { await message.channel.send('Usage: `$barrier <amount|full|zero>`'); await del(); return; }
            const userId = message.author.id;
            await ensurePlayer(userId, message.member.displayName);
            saveSnapshot(userId);
            const d = playerData.get(userId);
            const old = d.Barrier;
            
            if (args[0] === 'full') d.Barrier = d.maxBarrier;
            else if (args[0] === 'zero') d.Barrier = 0;
            else d.Barrier = Math.max(0, d.Barrier + parseInt(args[0]));
            
            const embed = new EmbedBuilder()
                .setColor(d.Barrier > old ? 0x00FF00 : 0xFF6B6B)
                .setTitle(d.characterName)
                .addFields({ name: `${EMOJIS.Barrier} Barrier`, value: `${old} → **${d.Barrier}**/${d.maxBarrier}`, inline: true });
            
            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }

        // $f / $m / $g / $s / $h — attribute buff/debuff
        // up: +1 die size (+2, max d12) · down: -1 die size (-2, min d6) · base: reset · no arg: view
        if (STAT_KEYS[cmd]) {
            const key = STAT_KEYS[cmd];
            const userId = message.author.id;
            const d = await ensurePlayer(userId, message.member.displayName);

            if (!d.stats || !d.stats[key]) {
                await message.channel.send('❌ No stats found — import your character sheet with `$set <sheet_url>` first.');
                await del();
                return;
            }

            if (!d.statMods) d.statMods = {};
            const base = d.stats[key];
            const oldVal = effectiveStat(d, key);
            const sub = args[0]?.toLowerCase();
            const label = key.toUpperCase();

            if (!sub) {
                const embed = new EmbedBuilder()
                    .setColor(0x0099FF)
                    .setTitle(`📊 ${d.characterName} — ${label}`)
                    .setDescription(`Current: **d${oldVal}**${statArrow(d, key)}${oldVal !== base ? ` (base d${base})` : ''}`);
                await message.channel.send({ embeds: [embed] });
                await del();
                return;
            }

            if (sub === 'up') {
                if (oldVal >= STAT_MAX) {
                    await message.channel.send(`❌ **${label}** is already at max (**d${STAT_MAX}**).`);
                    await del();
                    return;
                }
                d.statMods[key] = ((d.statMods[key] || 0)) + 2;
            } else if (sub === 'down') {
                if (oldVal <= STAT_MIN) {
                    await message.channel.send(`❌ **${label}** is already at min (**d${STAT_MIN}**).`);
                    await del();
                    return;
                }
                d.statMods[key] = ((d.statMods[key] || 0)) - 2;
            } else if (sub === 'base') {
                d.statMods[key] = 0;
            } else {
                await message.channel.send(`Usage: \`$${cmd} <up|down|base>\` — or \`$${cmd}\` alone to view`);
                await del();
                return;
            }

            const newVal = effectiveStat(d, key);
            const embed = new EmbedBuilder()
                .setColor(newVal > oldVal ? 0x00FF00 : newVal < oldVal ? 0xFF6B6B : 0xAAAAAA)
                .setTitle(`📊 ${d.characterName} — ${label}`)
                .setDescription(`d${oldVal} → **d${newVal}**${statArrow(d, key)}${newVal !== base ? ` (base d${base})` : ' (at base)'}`);

            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }

        // $overdrive [±amount|zero]
        if (cmd === 'overdrive' || cmd === 'od') {
            const encounter = getEncounter(channelId);
            if (!encounter.active) {
                await message.channel.send('❌ No active clash. Use `$clash start` first.');
                await del();
                return;
            }

            const old = encounter.overdrive;

            if (!args[0]) {
                const embed = new EmbedBuilder()
                    .setColor(0xFFAA00)
                    .setTitle(`${EMOJIS.Overdrive} Overdrive`)
                    .setDescription(`${buildOverdriveBar(old)}\n**${old} / ${MAX_OVERDRIVE}**`);
                await message.channel.send({ embeds: [embed] });
                await del();
                return;
            }

            if (args[0] === 'zero') {
                encounter.overdrive = 0;
            } else {
                const delta = parseInt(args[0]);
                if (isNaN(delta)) {
                    await message.channel.send('Usage: `$overdrive [±amount|zero]`\nExample: `$od +1`, `$od -2`, `$od zero`');
                    await del();
                    return;
                }
                encounter.overdrive = Math.max(0, Math.min(MAX_OVERDRIVE, old + delta));
            }

            const newVal = encounter.overdrive;
            const embed = new EmbedBuilder()
                .setColor(newVal >= MAX_OVERDRIVE ? 0xFF4400 : 0xFFAA00)
                .setTitle(`${EMOJIS.Overdrive} Overdrive`)
                .setDescription(`${buildOverdriveBar(newVal)}\n**${old} → ${newVal} / ${MAX_OVERDRIVE}**`)
                .setFooter(newVal >= MAX_OVERDRIVE ? { text: '⚠️ Overdrive is maxed!' } : { text: `Changed by ${newVal - old > 0 ? '+' : ''}${newVal - old}` });

            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }
        
        // $defend
        if (cmd === 'defend' || cmd === 'd') {
            const userId = message.author.id;
            await ensurePlayer(userId, message.member.displayName);
            saveSnapshot(userId);
            const d = playerData.get(userId);
            const oldA = d.Armor, oldB = d.Barrier;
            d.Armor += d.maxArmor;
            d.Barrier += d.maxBarrier;
            
            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle(`🛡️ ${d.characterName}`)
                .setDescription('**Defended!**')
                .addFields(
                    { name: `${EMOJIS.Armor} Armor`, value: `${oldA} +${d.maxArmor} = **${d.Armor}**`, inline: true },
                    { name: `${EMOJIS.Barrier} Barrier`, value: `${oldB} +${d.maxBarrier} = **${d.Barrier}**`, inline: true }
                );
            
            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }
        
        // $turn
        if (cmd === 'turn') {
            const user = message.mentions.users.first() || message.author;
            const member = await message.guild.members.fetch(user.id);
            await ensurePlayer(user.id, member.displayName);
            saveSnapshot(user.id);
            const d = playerData.get(user.id);
            d.Armor = 0;
            d.Barrier = 0;
            
            const embed = new EmbedBuilder()
                .setColor(0xFF6B6B)
                .setTitle(`💨 ${d.characterName}`)
                .setDescription('**Turn Reset!**')
                .addFields(
                    { name: `${EMOJIS.Armor} Armor`, value: `**0**/${d.maxArmor}`, inline: true },
                    { name: `${EMOJIS.Barrier} Barrier`, value: `**0**/${d.maxBarrier}`, inline: true }
                );
            
            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }
        
        // $rest
        if (cmd === 'rest') {
            const userId = message.author.id;
            await ensurePlayer(userId, message.member.displayName);
            saveSnapshot(userId);
            const d = playerData.get(userId);
            d.HP = d.maxHP;
            d.MP = d.maxMP;
            d.Armor = 0;
            d.Barrier = 0;
            d.statMods = {};
            savePlayerState(userId);
            
            const embed = new EmbedBuilder()
                .setColor(0x00FFFF)
                .setTitle(`✨ ${d.characterName}`)
                .setDescription('**Rested!**')
                .addFields(
                    { name: `${EMOJIS.HP} HP`, value: `**${d.HP}**/${d.maxHP}`, inline: true },
                    { name: `${EMOJIS.MP} MP`, value: `**${d.MP}**/${d.maxMP}`, inline: true },
                    { name: `${EMOJIS.Armor} Armor`, value: `**0**/${d.maxArmor}`, inline: true },
                    { name: `${EMOJIS.Barrier} Barrier`, value: `**0**/${d.maxBarrier}`, inline: true }
                );
            
            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }
        
        // $round — NEW: auto +1 Overdrive
        if (cmd === 'round') {
            const encounter = getEncounter(channelId);
            if (!encounter.active) {
                await message.channel.send('❌ No active clash. Use `$clash start`');
                await del();
                return;
            }
            
            let cleared = 0;
            for (const userId of encounter.combatants) {
                const d = playerData.get(userId);
                if (d) {
                    saveSnapshot(userId);
                    d.Armor = 0;
                    d.Barrier = 0;
                    cleared++;
                }
            }
            
            encounter.turnsTaken.clear();

            const oldOD = encounter.overdrive;
            encounter.overdrive = Math.min(MAX_OVERDRIVE, encounter.overdrive + 1);
            
            const embed = new EmbedBuilder()
                .setColor(0xFFAA00)
                .setTitle('🔄 New Round!')
                .setDescription(`Cleared **${cleared}** combatants`)
                .addFields(
                    { name: '🛡️ Armor', value: 'Set to **0**', inline: true },
                    { name: '✨ Barrier', value: 'Set to **0**', inline: true },
                    { name: '✅ Turns', value: 'Reset', inline: true },
                    { name: `${EMOJIS.Overdrive} Overdrive`, value: `${oldOD} → **${encounter.overdrive}** / ${MAX_OVERDRIVE} (+1 new round)`, inline: true }
                );
            
            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }

        // $random [count] — pick random distinct targets from clash list
        if (cmd === 'random') {
            const encounter = getEncounter(channelId);
            if (!encounter.active || encounter.combatants.length === 0) {
                await message.channel.send('❌ No active clash with combatants in this channel.');
                await del();
                return;
            }

            let count = parseInt(args[0]) || 1;
            count = Math.max(1, Math.min(count, encounter.combatants.length));

            // Fisher-Yates shuffle on slot indices
            const indices = encounter.combatants.map((_, i) => i);
            for (let i = indices.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [indices[i], indices[j]] = [indices[j], indices[i]];
            }
            const picked = indices.slice(0, count).sort((a, b) => a - b);

            const lines = picked.map(idx => {
                const d = playerData.get(encounter.combatants[idx]);
                return `**${idx + 1}.** ${d ? d.characterName : 'Unknown'}`;
            });

            const embed = new EmbedBuilder()
                .setColor(0xAA00FF)
                .setTitle(`🎯 Random Target${count > 1 ? 's' : ''}`)
                .setDescription(lines.join('\n'))
                .setFooter({ text: 'Slot numbers usable with $dmg' });

            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }

        // $pet — pets live in the clash, listed at the bottom with letters
        // $pet join <hp> <mp> [name] · $pet hp <±|full|zero> · $pet mp <±|full|zero> · $pet leave · $pet (view)
        if (cmd === 'pet') {
            const encounter = getEncounter(channelId);
            if (!encounter.active) {
                await message.channel.send('❌ No active clash. Use `$clash start` first.');
                await del();
                return;
            }
            if (!encounter.pets) encounter.pets = [];

            const userId = message.author.id;
            await ensurePlayer(userId, message.member.displayName);
            const ownerName = playerData.get(userId).characterName;
            const myPet = encounter.pets.find(p => p.ownerId === userId);
            const sub = args[0]?.toLowerCase();

            if (sub === 'join') {
                if (myPet) {
                    await message.channel.send(`❌ You already have **${myPet.name}** in this clash. Use \`$pet leave\` first.`);
                    await del();
                    return;
                }
                const hp = parseInt(args[1]);
                const mp = parseInt(args[2]);
                if (isNaN(hp) || isNaN(mp)) {
                    await message.channel.send('Usage: `$pet join <hp> <mp> [name]`\nExample: `$pet join 30 10 Fluffy`');
                    await del();
                    return;
                }
                const name = args.slice(3).join(' ') || `${ownerName}'s Pet`;

                encounter.pets.push({ ownerId: userId, name, HP: hp, MP: mp, maxHP: hp, maxMP: mp });
                const letter = String.fromCharCode(97 + encounter.pets.length - 1);

                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle(`🐾 ${name} joined the clash!`)
                    .addFields(
                        { name: `${EMOJIS.HP} HP`, value: `${hp}/${hp}`, inline: true },
                        { name: `${EMOJIS.MP} MP`, value: `${mp}/${mp}`, inline: true }
                    )
                    .setFooter({ text: `Slot ${letter} · owner: ${ownerName}` });

                await message.channel.send({ embeds: [embed] });
                await del();
                return;
            }

            if (sub === 'leave') {
                if (!myPet) {
                    await message.channel.send('❌ You have no pet in this clash.');
                    await del();
                    return;
                }
                encounter.pets = encounter.pets.filter(p => p.ownerId !== userId);
                await message.channel.send(`🐾 **${myPet.name}** left the clash.`);
                await del();
                return;
            }

            if (sub === 'hp' || sub === 'mp') {
                if (!myPet) {
                    await message.channel.send('❌ You have no pet. Use `$pet join <hp> <mp>` first.');
                    await del();
                    return;
                }
                if (!args[1]) {
                    await message.channel.send(`Usage: \`$pet ${sub} <±amount|full|zero>\``);
                    await del();
                    return;
                }

                const key = sub === 'hp' ? 'HP' : 'MP';
                const maxKey = sub === 'hp' ? 'maxHP' : 'maxMP';
                const emoji = sub === 'hp' ? EMOJIS.HP : EMOJIS.MP;
                const old = myPet[key];

                if (args[1] === 'full') myPet[key] = myPet[maxKey];
                else if (args[1] === 'zero') myPet[key] = 0;
                else {
                    const delta = parseInt(args[1]);
                    if (isNaN(delta)) {
                        await message.channel.send(`Usage: \`$pet ${sub} <±amount|full|zero>\``);
                        await del();
                        return;
                    }
                    myPet[key] = Math.max(0, myPet[key] + delta);
                }

                const embed = new EmbedBuilder()
                    .setColor(myPet[key] > old ? 0x00FF00 : 0xFF6B6B)
                    .setTitle(`🐾 ${myPet.name}`)
                    .addFields({ name: `${emoji} ${key}`, value: `${old} → **${myPet[key]}**/${myPet[maxKey]}`, inline: true });
                if (sub === 'hp' && myPet.HP === 0) embed.setFooter({ text: '💀 HP reached 0!' });

                await message.channel.send({ embeds: [embed] });
                await del();
                return;
            }

            // No subcommand — view own pet
            if (!sub) {
                if (!myPet) {
                    await message.channel.send('❌ You have no pet. Use `$pet join <hp> <mp> [name]`');
                    await del();
                    return;
                }
                const letter = String.fromCharCode(97 + encounter.pets.indexOf(myPet));
                const embed = new EmbedBuilder()
                    .setColor(0x0099FF)
                    .setTitle(`🐾 ${myPet.name}`)
                    .addFields(
                        { name: `${EMOJIS.HP} HP`, value: `${myPet.HP}/${myPet.maxHP}`, inline: true },
                        { name: `${EMOJIS.MP} MP`, value: `${myPet.MP}/${myPet.maxMP}`, inline: true }
                    )
                    .setFooter({ text: `Slot ${letter} · owner: ${ownerName}` });
                await message.channel.send({ embeds: [embed] });
                await del();
                return;
            }

            await message.channel.send('Usage: `$pet join <hp> <mp> [name]` · `$pet hp <±|full|zero>` · `$pet mp <±|full|zero>` · `$pet leave` · `$pet` (view)');
            await del();
            return;
        }
        
        // $ga <d1> <d2> <mod> <gate> [type]
        // FIX 2: targets removed — anyone can click Take Damage
        // NEW GATE RULE: miss only if BOTH dice roll at or below gate
        if (cmd === 'ga') {
            if (args.length < 4) {
                await message.channel.send('Usage: `$ga <d1> <d2> <mod> <gate> [a|b|t] [@players / slot#...]`\n`a`=armor (default), `b`=barrier, `t`=true\nTargets are a ping/indicator only — anyone can still click Take Damage.');
                await del();
                return;
            }
            
            const [d1, d2, mod, gate] = [parseInt(args[0]), parseInt(args[1]), parseInt(args[2]), parseInt(args[3])];
            
            let dmgType = 'armor';
            let targetArgs = args.slice(4);
            if (targetArgs.length > 0 && ['a','b','t'].includes(targetArgs[0].toLowerCase())) {
                const flag = targetArgs.shift().toLowerCase();
                if (flag === 'b') dmgType = 'barrier';
                else if (flag === 't') dmgType = 'true';
            }

            // Targets are an INDICATOR only — button stays open to everyone.
            // Accepts @mentions and/or clash slot numbers.
            const encounter = getEncounter(channelId);
            const targetIds = new Set();
            for (const [uid] of message.mentions.users) targetIds.add(uid);
            for (const s of targetArgs) {
                const n = parseInt(s);
                if (!isNaN(n) && encounter.active) {
                    const uid = encounter.combatants[n - 1];
                    if (uid) targetIds.add(uid);
                }
            }
            const targetLine = targetIds.size > 0 ? [...targetIds].map(id => `<@${id}>`).join(' ') : null;
            
            const r1 = Math.floor(Math.random() * d1) + 1;
            const r2 = Math.floor(Math.random() * d2) + 1;
            const hr = Math.max(r1, r2);
            const dmg = hr + mod;
            
            const fumble = r1 === 1 && r2 === 1;
            const crit = !fumble && r1 === r2 && r1 >= 6;
            const hit = fumble ? false : crit ? true : !(r1 <= gate && r2 <= gate);
            
            if (fumble || !hit) {
                const embed = new EmbedBuilder()
                    .setColor(fumble ? 0x800000 : 0xFF0000)
                    .setTitle('🎲 GM Attack')
                    .addFields(
                        { name: 'Dice', value: `d${d1}: **${r1}** | d${d2}: **${r2}** = **${r1 + r2}**\nGate: **${gate}** (miss if both ≤**${gate}**)`, inline: false },
                        { name: 'Damage', value: `HR = **${hr}**\n${hr} + ${mod} = **${dmg}**`, inline: false }
                    )
                    .setDescription(fumble ? '💀 **FUMBLE!**' : '❌ **MISS**');

                if (targetLine) embed.addFields({ name: '🎯 For', value: targetLine, inline: false });
                
                await message.channel.send({ embeds: [embed] });
                await del();
                return;
            }
            
            const typeLabel = dmgType === 'armor' ? 'Armor' : dmgType === 'barrier' ? 'Barrier' : 'True';
            const embed = new EmbedBuilder()
                .setColor(crit ? 0xFFD700 : 0xFF6B6B)
                .setTitle('🎲 GM Attack — HIT!')
                .addFields(
                    { name: 'Dice', value: `d${d1}: **${r1}** | d${d2}: **${r2}** = **${r1 + r2}**\nGate: **${gate}** (miss if both ≤**${gate}**)`, inline: false },
                    { name: 'Damage', value: `HR = **${hr}**\n${hr} + ${mod} = **${dmg}** ${typeLabel}`, inline: false }
                )
                .setDescription(crit ? '⭐ **CRITICAL!**' : '✅ **HIT!**')
                .setFooter({ text: 'Click Take Damage to apply — use $defend first to add defenses' });

            if (targetLine) embed.addFields({ name: '🎯 For', value: targetLine, inline: false });
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`ga_take_${dmg}_${dmgType}_${message.id}`)
                    .setLabel('💔 Take Damage')
                    .setStyle(ButtonStyle.Danger)
            );
            
            await message.channel.send({ embeds: [embed], components: [row] });
            await del();
            return;
        }
        
        // $clash
        if (cmd === 'clash' || cmd === 'c') {
            const sub = args[0]?.toLowerCase();
            const encounter = getEncounter(channelId);
            
            if (sub === 'start') {
                encounter.active = true;
                encounter.combatants = [];
                encounter.turnsTaken = new Set();
                encounter.overdrive = 0;
                encounter.pets = [];
                encounter.crisisTriggered = new Set();
                await message.channel.send(`⚔️ Clash started! ${EMOJIS.Overdrive} Overdrive reset to 0.`);
                await del();
                return;
            }
            
            if (sub === 'end') {
                // Wipe stat buffs/debuffs for everyone in the clash (scene-scoped)
                for (const userId of encounter.combatants) {
                    const d = playerData.get(userId);
                    if (d && d.statMods) d.statMods = {};
                }
                encounter.active = false;
                encounter.combatants = [];
                encounter.turnsTaken = new Set();
                encounter.overdrive = 0;
                encounter.pets = [];
                encounter.crisisTriggered = new Set();
                await message.channel.send('✅ Clash ended! All stat buffs/debuffs reset to base.');
                await del();
                return;
            }
            
            if (sub === 'join') {
                if (!encounter.active) { await message.channel.send('❌ No clash. Use `$clash start`'); await del(); return; }
                
                const userId = message.author.id;
                
                if (encounter.combatants.includes(userId)) {
                    await message.channel.send('❌ You\'re already in the clash!');
                    await del();
                    return;
                }
                
                await ensurePlayer(userId, message.member.displayName);
                
                encounter.combatants.push(userId);
                const d = playerData.get(userId);
                
                await message.channel.send(`✅ **${d.characterName}** joined the clash!`);
                await del();
                return;
            }
            
            if (sub === 'add') {
                if (!encounter.active) { await message.channel.send('❌ No clash. Use `$clash start`'); await del(); return; }
                
                const mentioned = message.mentions.users;
                if (mentioned.size === 0) { await message.channel.send('❌ Mention players: `$clash add @player`'); await del(); return; }
                
                let added = 0;
                for (const [userId] of mentioned) {
                    if (!encounter.combatants.includes(userId)) {
                        const member = await message.guild.members.fetch(userId);
                        await ensurePlayer(userId, member.displayName);
                        encounter.combatants.push(userId);
                        added++;
                    }
                }
                
                await message.channel.send(`✅ Added ${added} to clash!`);
                await del();
                return;
            }
            
            if (sub === 'leave') {
                if (!encounter.active) { await message.channel.send('❌ No clash.'); await del(); return; }
                const userId = message.author.id;
                if (!encounter.combatants.includes(userId)) {
                    await message.channel.send('❌ You\'re not in this clash.');
                    await del();
                    return;
                }
                encounter.combatants = encounter.combatants.filter(id => id !== userId);
                encounter.turnsTaken.delete(userId);
                const pet = (encounter.pets || []).find(p => p.ownerId === userId);
                if (pet) encounter.pets = encounter.pets.filter(p => p.ownerId !== userId);
                const d = playerData.get(userId);
                await message.channel.send(`👋 **${d ? d.characterName : 'Player'}** left the clash${pet ? ` (with **${pet.name}**)` : ''}.`);
                await del();
                return;
            }

            if (sub === 'remove') {
                if (!encounter.active) { await message.channel.send('❌ No clash.'); await del(); return; }

                // Collect targets first (mentions + slot numbers), then remove — so slot numbers don't shift mid-removal
                const toRemove = new Set();
                for (const [uid] of message.mentions.users) toRemove.add(uid);
                for (const s of args.slice(1)) {
                    const n = parseInt(s);
                    if (!isNaN(n)) {
                        const uid = encounter.combatants[n - 1];
                        if (uid) toRemove.add(uid);
                    }
                }

                if (toRemove.size === 0) {
                    await message.channel.send('Usage: `$clash remove @player` or `$clash remove <slot#>`');
                    await del();
                    return;
                }

                const removedNames = [];
                for (const uid of toRemove) {
                    if (encounter.combatants.includes(uid)) {
                        encounter.combatants = encounter.combatants.filter(id => id !== uid);
                        encounter.turnsTaken.delete(uid);
                        encounter.pets = (encounter.pets || []).filter(p => p.ownerId !== uid);
                        const d = playerData.get(uid);
                        removedNames.push(d ? d.characterName : 'Unknown');
                    }
                }

                if (removedNames.length === 0) {
                    await message.channel.send('❌ No matching combatants found.');
                } else {
                    await message.channel.send(`🚪 Removed from clash: **${removedNames.join('**, **')}** (pets included). Slot numbers have shifted — check \`$clash list\`.`);
                }
                await del();
                return;
            }

            // FIX 3: $clash list — use description text instead of fields to avoid white box
            if (sub === 'list') {
                if (!encounter.active) { await message.channel.send('❌ No clash.'); await del(); return; }
                if (encounter.combatants.length === 0) { await message.channel.send('⚔️ No combatants.'); await del(); return; }
                
                const lines = [];
                let num = 1;
                for (const userId of encounter.combatants) {
                    const d = playerData.get(userId);
                    if (d) {
                        const icon = encounter.turnsTaken.has(userId) ? ' ✅' : '';
                        lines.push(`**${num}.**${icon} **${d.characterName}**${crisisTag(d)}`);
                        lines.push(`${EMOJIS.HP} ${d.HP}/${d.maxHP} · ${EMOJIS.MP} ${d.MP}/${d.maxMP} · ${EMOJIS.IP} ${d.IP}/${d.maxIP}`);
                        lines.push(`${EMOJIS.Armor} ${d.Armor}/${d.maxArmor} · ${EMOJIS.Barrier} ${d.Barrier}/${d.maxBarrier}`);
                        lines.push('');
                        num++;
                    }
                }

                // Pets — always at the bottom, lettered a/b/c
                const pets = encounter.pets || [];
                if (pets.length > 0) {
                    lines.push('🐾 **Pets**');
                    pets.forEach((pet, i) => {
                        const letter = String.fromCharCode(97 + i); // a, b, c...
                        const owner = playerData.get(pet.ownerId);
                        lines.push(`**${letter}.** **${pet.name}**${owner ? ` (${owner.characterName})` : ''}`);
                        lines.push(`${EMOJIS.HP} ${pet.HP}/${pet.maxHP} · ${EMOJIS.MP} ${pet.MP}/${pet.maxMP}`);
                        lines.push('');
                    });
                }
                
                const embed = new EmbedBuilder()
                    .setColor(0xFFAA00)
                    .setTitle('⚔️ Clash')
                    .setDescription(
                        `${EMOJIS.Overdrive} **Overdrive:** ${buildOverdriveBar(encounter.overdrive)} **${encounter.overdrive}/${MAX_OVERDRIVE}**\n\n` +
                        lines.join('\n')
                    )
                    .setTimestamp();
                
                await message.channel.send({ embeds: [embed] });
                await del();
                return;
            }
            
            await message.channel.send('Usage: `$clash <start|join|add|leave|remove|list|end>`');
            await del();
            return;
        }

        //$debug
        if (cmd === 'debug') {
            const firstArg = args[0];
            if (!firstArg?.includes('docs.google.com')) {
                await message.channel.send('Usage: `$debug <sheet_url>`');
                await del();
                return;
            }

            const parsed = parseSheetUrl(firstArg);
            const data = await fetchSheetData(parsed.spreadsheetId, parsed.gid);
            if (!data) { await message.channel.send('❌ Could not fetch sheet.'); await del(); return; }

            // Print first 40 rows, columns A–AE
            let output = '';
            for (let r = 0; r < Math.min(40, data.length); r++) {
                for (let c = 0; c < Math.min(35, (data[r] || []).length); c++) {
                    const val = data[r][c];
                    if (val && val.trim()) {
                        const colLetter = c < 26 ? String.fromCharCode(65 + c) : 'A' + String.fromCharCode(65 + c - 26);
                        output += `${colLetter}${r + 1}=${val}  `;
                    }
                }
            }

            // Split into chunks (Discord 2000 char limit)
            const chunks = output.match(/.{1,1900}/g) || ['(empty)'];
            for (const chunk of chunks) {
                await message.channel.send('```' + chunk + '```');
            }
            await del();
            return;
        }

        // $cast [school|name] — show cast schools, a school's list, or one cast
        if (cmd === 'cast' || cmd === 'casts') {
            const schoolKeys = Object.keys(castData);
            if (schoolKeys.length === 0) {
                await message.channel.send('❌ Cast data not loaded.');
                await del();
                return;
            }

            // Bare $cast — list schools
            if (!args[0]) {
                const lines = schoolKeys.map(k => {
                    const s = castData[k];
                    return `**${s.name}** (${s.source}, ${s.attribute}) — ${s.casts.length} casts`;
                });
                const embed = new EmbedBuilder()
                    .setColor(0x00BFFF)
                    .setTitle('🪄 Cast Schools')
                    .setDescription(`${lines.join('\n')}\n\nUse \`$cast <school>\` for the list or \`$cast <name>\` for one cast.\nExample: \`$cast white\` · \`$cast cure\``);
                await message.channel.send({ embeds: [embed] });
                await del();
                return;
            }

            const query = args.join(' ').toLowerCase();

            // School match first: key or school name
            let school = schoolKeys.find(k => k === query)
                || schoolKeys.find(k => castData[k].name.toLowerCase() === query)
                || schoolKeys.find(k => k.startsWith(query))
                || schoolKeys.find(k => castData[k].name.toLowerCase().startsWith(query));

            if (school) {
                const s = castData[school];
                const embed = new EmbedBuilder()
                    .setColor(0x9B59B6)
                    .setTitle(`🪄 ${s.name}`)
                    .setDescription(`*${s.source} · offensive casts use ${s.attribute} and require an arcane weapon*`);
                for (const c of s.casts) embed.addFields(castField(c));
                await message.channel.send({ embeds: [embed] });
                await del();
                return;
            }

            // Single cast search across all schools: exact -> startsWith -> includes
            const all = [];
            for (const k of schoolKeys) {
                for (const c of castData[k].casts) all.push({ school: castData[k], cast: c });
            }
            let matches = all.filter(e => e.cast.name.toLowerCase() === query);
            if (matches.length === 0) matches = all.filter(e => e.cast.name.toLowerCase().startsWith(query));
            if (matches.length === 0) matches = all.filter(e => e.cast.name.toLowerCase().includes(query));

            if (matches.length === 0) {
                await message.channel.send(`❌ No school or cast matching **${args.join(' ')}**. Try \`$cast\` to see the schools.`);
                await del();
                return;
            }
            if (matches.length > 1) {
                await message.channel.send(`❓ Multiple matches: ${matches.map(e => `**${e.cast.name}**`).join(', ')} — be more specific.`);
                await del();
                return;
            }

            const { school: s, cast: c } = matches[0];
            const field = castField(c);
            const embed = new EmbedBuilder()
                .setColor(0x9B59B6)
                .setTitle(`🪄 ${c.name} (${c.ap})`)
                .setDescription(`*${s.name} · ${s.source}${c.offensive ? ` · ${s.attribute}` : ''}*\n\n${field.value}`);
            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }

        // $class [name] — show class abilities from classes.json
        if (cmd === 'class') {
            const keys = Object.keys(classData);
            if (keys.length === 0) {
                await message.channel.send('❌ Class data not loaded.');
                await del();
                return;
            }

            // Bare $class — list all classes
            if (!args[0]) {
                const names = keys.map(k => classData[k].name).join(' · ');
                const embed = new EmbedBuilder()
                    .setColor(0x00BFFF)
                    .setTitle('📚 Classes')
                    .setDescription(`${names}\n\nUse \`$class <name>\` for details. Partial names work: \`$class bers\``);
                await message.channel.send({ embeds: [embed] });
                await del();
                return;
            }

            // Match: exact -> startsWith -> includes
            const query = args[0].toLowerCase();
            let matches = keys.filter(k => k === query);
            if (matches.length === 0) matches = keys.filter(k => k.startsWith(query));
            if (matches.length === 0) matches = keys.filter(k => k.includes(query));

            if (matches.length === 0) {
                await message.channel.send(`❌ No class matching **${args[0]}**. Try \`$class\` to see the list.`);
                await del();
                return;
            }
            if (matches.length > 1) {
                await message.channel.send(`❓ Multiple matches: ${matches.map(k => `**${classData[k].name}**`).join(', ')} — be more specific.`);
                await del();
                return;
            }

            const c = classData[matches[0]];
            const embed = new EmbedBuilder()
                .setColor(0x9B59B6)
                .setTitle(`📚 ${c.name}`)
                .setDescription(`*${c.aliases}*\n**Proficiencies:** ${c.proficiencies}`);

            for (const skill of c.skills) {
                embed.addFields({
                    name: `${skill.name} (${skill.cost}) — ${skill.maxSP}✦`,
                    value: skill.summary,
                    inline: false
                });
            }

            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }

        // $help
        if (cmd === 'help') {
            const embed = new EmbedBuilder()
                .setColor(0x00BFFF)
                .setTitle('📖 Eien Saga — Command Guide')
                .addFields(
                    {
                        name: '📚 Class Reference',
                        value: '`$class` — list all classes · `$class <name>` — show its 5 abilities\n`$cast` — list cast schools · `$cast <school>` — full list · `$cast <name>` — one cast\nPartial names work: `$class bers` · `$cast frost`',
                        inline: false
                    },
                    { 
                        name: '🎮 Setup', 
                        value: '`$set <name> <hp> <mp> <ip> <armor> <barrier>`\nExample: `$set Gandalf 100 50 100 20 15`\n`$set <sheet_url>` — import from Google Sheets (stores FMGSH stats)\n\n`$view` or `$view @player` — stats, crisis status, base stats\n`$image <url>` — set your character image (thumbnail on `$view`, `$a`, `$r`) · `$image` alone clears it', 
                        inline: false 
                    },
                    { 
                        name: '🎲 Dice Roller', 
                        value: '`$r <d1|stat> <d2|stat> [mod]` — sum of both dice + mod\nUse stat letters `f m g s h` to roll your attribute dice.\nFumbles and criticals apply.\nExample: `$r 6 6 2` = 2d6+2 · `$r f g 3`', 
                        inline: false 
                    },
                    {
                        name: '📊 Attribute Buffs',
                        value: '`$f` `$m` `$g` `$s` `$h` + `up`/`down`/`base`\n`up` = +1 die size (max d12) · `down` = −1 die size (min d6) · `base` = reset\nBuffed stats show 🔼/🔻 on `$view`. All buffs auto-reset on `$clash end` (scene-scoped).\nExample: `$f up` · `$g down` · `$m base`',
                        inline: false
                    },
                    {
                        name: '🐾 Pet',
                        value: '`$pet join <hp> <mp> [name]` — add your pet to the clash (listed at the bottom as a/b/c)\n`$pet hp <±|full|zero>` · `$pet mp <±|full|zero>` — adjust\n`$pet` — view · `$pet leave` — remove\nExample: `$pet join 30 10 Fluffy` · `$pet hp -10`',
                        inline: false
                    },
                    { 
                        name: '⚔️ Attack (Player)', 
                        value: '`$a <d1|stat> <d2|stat> [mod] [gate]` — mod defaults 0, gate defaults 1\nUse stat letters `f m g s h` to roll your attribute dice (buffs included).\nMiss only if **both** dice roll at or below gate.\nExample: `$a 10 8` · `$a f g 5 2`', 
                        inline: false 
                    },
                    { 
                        name: '🎲 GM Attack', 
                        value: '`$ga <d1> <d2> <mod> <gate> [a|b|t] [@players / slot#...]`\nExample: `$ga 10 8 15 1 b @Aoi 3`\nMiss only if **both** dice roll at or below gate.\n**Types:** `a`=armor (default), `b`=barrier, `t`=true\nTargets show as a 🎯 ping on the message but anyone can still click **Take Damage**.', 
                        inline: false 
                    },
                    {
                        name: '💔 Apply Damage (Cascade)',
                        value: '`$dmg <amount> [a|b|t] [slot#/letter...]`\nApplies damage through Armor/Barrier first, overflow hits HP.\nNo slots = targets yourself. Numbers target players, letters target pets (HP directly).\n⚠️ When targeting pets, always include the type flag first: `$dmg 20 a a` hits pet **a** with armor damage.\nExample: `$dmg 20 a 1 3` · `$dmg 15 b` (self) · `$dmg 10 t a b` (pets a & b)',
                        inline: false
                    },
                    {
                        name: '🎯 Random Target',
                        value: '`$random [count]` — pick random combatants from the clash\nExample: `$random 3` picks 3 distinct targets with slot numbers',
                        inline: false
                    },
                    { 
                        name: '💉 Resources', 
                        value: '`$hp`, `$mp`, `$ip`, `$armor`, `$barrier` — use `±amount`, `full`, or `zero`\nExample: `$hp -20` · `$mp +50` · `$armor full`\n\n`$defend` or `$d` — add max armor+barrier\n`$turn [@player]` — clear armor+barrier to 0\n`$rest` — HP/MP to max, armor/barrier to 0, buffs reset', 
                        inline: false 
                    },
                    {
                        name: '↩️ Undo',
                        value: '`$undo` — revert your last stat change (up to 5 deep)\nWorks after `$dmg`, `$hp`, `$mp`, `$ip`, `$armor`, `$barrier`, `$defend`, `$turn`, `$rest`, and clicking Take Damage.',
                        inline: false
                    },
                    {
                        name: `${EMOJIS.Overdrive} Overdrive (Shared Pool)`,
                        value: `\`$overdrive [±amount|zero]\` — adjust or view the shared Overdrive pool (max ${MAX_OVERDRIVE})\nAlias: \`$od\`\nExample: \`$od +1\` · \`$od -2\` · \`$od zero\`\nRequires an active clash.`,
                        inline: false
                    },
                    { 
                        name: '⚔️ Clash', 
                        value: '`$clash start` — start encounter (resets Overdrive, isolated to this channel)\n`$clash join` — add yourself · `$clash leave` — leave (pet too)\n`$clash add @players` — add others · `$clash remove @player/slot#` — remove others (pet too)\n`$clash list` — numbered combatants + Overdrive + crisis tags\n`$clash end` — end encounter\n\n`$round` — new round (clears armor/barrier, resets turns, **+1 Overdrive**)\n\nEach channel has its own independent clash. Use slot numbers from `$clash list` with `$dmg`.', 
                        inline: false 
                    },
                    {
                        name: '🩸 Crisis',
                        value: 'Crisis = HP at or below **half of Max HP** (rounded down). Tagged automatically on damage, `$view`, and `$clash list`.\nFirst crisis per PC per clash prompts the party to gain **1 Overdrive** (apply with `$od +1`).',
                        inline: false
                    }
                )
                .setFooter({ text: 'Eien Saga Combat Tracker' });
            
            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }
        
    } catch (err) {
        console.error('Error:', err);
        await message.channel.send('❌ Error occurred.');
    }
});

// ========================================
// BUTTON HANDLER — $ga take damage
// No auth — anyone can press Take Damage (FIX 2)
// customId format: ga_take_{dmg}_{dmgType}_{messageId}
// ========================================
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    
    const parts = interaction.customId.split('_');
    if (parts[0] !== 'ga') return;
    
    try {
        const dmg = parseInt(parts[2]);
        const dmgType = parts[3];

        const userId = interaction.user.id;
        const member = interaction.member;
        await ensurePlayer(userId, member.displayName);

        if (!(await tryLoadPlayer(userId))) {
            await interaction.reply({ content: '❌ No character found. Use `$set` first.', ephemeral: true });
            return;
        }

        saveSnapshot(userId); // FIX 4: save snapshot so $undo works after button click
        const d = playerData.get(userId);

        const cascadeLines = applyDamageCascade(d, dmg, dmgType);
        savePlayerState(userId);
        const crisisNotice = checkFirstCrisis(interaction.channelId, userId, d);
        if (crisisNotice) cascadeLines.push(crisisNotice);

        const embed = new EmbedBuilder()
            .setColor(0xFF6B6B)
            .setTitle(`💔 ${d.characterName} — Took the hit!`)
            .setDescription(cascadeLines.join('\n'));

        if (d.HP === 0) embed.setFooter({ text: '💀 HP reached 0!' });
        
        await interaction.reply({ embeds: [embed] });
    } catch (err) {
        console.error('Button error:', err);
        await interaction.reply({ content: '❌ Error', ephemeral: true });
    }
});

client.login(process.env.DISCORD_TOKEN);
