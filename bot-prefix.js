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
            overdrive: 0
        });
    }
    return activeEncounters.get(channelId);
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
            return {
                username: r.username, characterName: r.character_name,
                HP: r.max_hp, MP: r.max_mp, IP: r.max_ip, Armor: 0, Barrier: 0,
                maxHP: r.max_hp, maxMP: r.max_mp, maxIP: r.max_ip, maxArmor: r.max_armor, maxBarrier: r.max_barrier
            };
        }
    } catch (err) { console.error('Load error:', err); }
    return null;
}

async function saveCharacterSheet(userId, data) {
    if (!useDatabase) return;
    try {
        await pool.query(`
            INSERT INTO players (user_id, username, character_name, hp, mp, ip, armor, barrier, max_hp, max_mp, max_ip, max_armor, max_barrier, status_effects, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id) DO UPDATE SET
                username = $2, character_name = $3, max_hp = $9, max_mp = $10, max_ip = $11, max_armor = $12, max_barrier = $13, updated_at = CURRENT_TIMESTAMP
        `, [userId, data.username, data.characterName, data.maxHP, data.maxMP, data.maxIP, 0, 0, data.maxHP, data.maxMP, data.maxIP, data.maxArmor, data.maxBarrier, '[]']);
    } catch (err) { console.error('Save error:', err); }
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
                lines.push(`${EMOJIS.HP} HP overflow: **${oldHP}** → **${d.HP}** (−${overflow})`);
            }
        } else {
            d.HP = Math.max(0, d.HP - dmg);
            lines.push(`${EMOJIS.Armor} No Armor — hit HP directly`);
            lines.push(`${EMOJIS.HP} HP: **${oldHP}** → **${d.HP}** (−${dmg})`);
        }
    } else if (dmgType === 'barrier') {
        if (d.Barrier > 0) {
            const absorbed = Math.min(d.Barrier, dmg);
            const overflow = dmg - absorbed;
            d.Barrier = Math.max(0, d.Barrier - dmg);
            lines.push(`${EMOJIS.Barrier} Barrier: **${oldBarrier}** → **${d.Barrier}** (absorbed ${absorbed})`);
            if (overflow > 0) {
                d.HP = Math.max(0, d.HP - overflow);
                lines.push(`${EMOJIS.HP} HP overflow: **${oldHP}** → **${d.HP}** (−${overflow})`);
            }
        } else {
            d.HP = Math.max(0, d.HP - dmg);
            lines.push(`${EMOJIS.Barrier} No Barrier — hit HP directly`);
            lines.push(`${EMOJIS.HP} HP: **${oldHP}** → **${d.HP}** (−${dmg})`);
        }
    } else {
        d.HP = Math.max(0, d.HP - dmg);
        lines.push(`💀 True damage bypasses defenses`);
        lines.push(`${EMOJIS.HP} HP: **${oldHP}** → **${d.HP}** (−${dmg})`);
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

client.on('ready', () => {
    console.log(`✅ ${client.user.tag}`);
    console.log(`✅ Prefix: ${PREFIX}`);
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
                    maxArmor: result.maxArmor, maxBarrier: result.maxBarrier
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

            if (!playerData.has(user.id)) {
                await message.channel.send(`❌ No character set for **${member.displayName}**. Use \`$set\` first.`);
                await del();
                return;
            }

            const d = playerData.get(user.id);
            
            const embed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle(`${d.characterName}`)
                .setThumbnail(d.imageUrl || null)
                .addFields(
                    { name: `${EMOJIS.HP} HP`, value: `${d.HP}/${d.maxHP}`, inline: true },
                    { name: `${EMOJIS.MP} MP`, value: `${d.MP}/${d.maxMP}`, inline: true },
                    { name: `${EMOJIS.IP} IP`, value: `${d.IP}/${d.maxIP}`, inline: true },
                    { name: `${EMOJIS.Armor} Armor`, value: `${d.Armor}/${d.maxArmor}`, inline: true },
                    { name: `${EMOJIS.Barrier} Barrier`, value: `${d.Barrier}/${d.maxBarrier}`, inline: true }
                );
            
            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }

        // FIX 4: $undo — restore previous state
        if (cmd === 'undo') {
            const userId = message.author.id;

            if (!playerData.has(userId)) {
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

            if (slots.length === 0) {
                const userId = message.author.id;
                if (!playerData.has(userId)) {
                    await message.channel.send('❌ No character found. Use `$set` first.');
                    await del();
                    return;
                }
                saveSnapshot(userId);
                const d = playerData.get(userId);
                const cascadeLines = applyDamageCascade(d, dmg, dmgType);
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
                const embed = new EmbedBuilder()
                    .setColor(0xFF6B6B)
                    .setTitle(`💔 ${slot}. ${d.characterName} — ${dmg} ${typeLabelFn(dmgType)} Damage`)
                    .setDescription(cascadeLines.join('\n'));
                if (d.HP === 0) embed.setFooter({ text: '💀 HP reached 0!' });
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
            initPlayer(userId, message.member.displayName);
            const d = playerData.get(userId);

            if (!args[0]) {
                d.imageUrl = null;
                await message.channel.send(`🖼️ **${d.characterName}**'s image cleared.`);
                await del();
                return;
            }

            d.imageUrl = args[0];

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
                await message.channel.send('Usage: `$r <d1> <d2> [mod]`\nExample: `$r 6 6 2` = 2d6+2');
                await del();
                return;
            }

            const d1 = parseInt(args[0]);
            const d2 = parseInt(args[1]);
            const mod = args[2] !== undefined ? parseInt(args[2]) : 0;

            if (isNaN(d1) || isNaN(d2) || isNaN(mod) || d1 < 1 || d2 < 1) {
                await message.channel.send('❌ All values must be numbers (dice at least 1).');
                await del();
                return;
            }

            const r1 = Math.floor(Math.random() * d1) + 1;
            const r2 = Math.floor(Math.random() * d2) + 1;
            const total = r1 + r2 + mod;

            const embed = new EmbedBuilder()
                .setColor(0x00BFFF)
                .setTitle(`🎲 ${message.member.displayName} rolls`)
                .setDescription(`d${d1}: **${r1}** + d${d2}: **${r2}**${mod !== 0 ? ` + ${mod}` : ''} = **${total}**`);

            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }

        // $a <d1> <d2> [mod] [gate] — mod defaults 0, gate defaults 1
        // NEW GATE RULE: miss only if BOTH dice roll at or below gate
        if (cmd === 'a' || cmd === 'attack') {
            if (args.length < 2) {
                await message.channel.send('Usage: `$a <d1> <d2> [mod] [gate]`\nDefaults: mod=0, gate=1');
                await del();
                return;
            }
            
            const d1 = parseInt(args[0]);
            const d2 = parseInt(args[1]);
            const mod = args[2] !== undefined ? parseInt(args[2]) : 0;
            const gate = args[3] !== undefined ? parseInt(args[3]) : 1;

            if (isNaN(d1) || isNaN(d2) || isNaN(mod) || isNaN(gate)) {
                await message.channel.send('❌ All values must be numbers!');
                await del();
                return;
            }

            const userId = message.author.id;
            initPlayer(userId, message.member.displayName);
            const data = playerData.get(userId);
            
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
                .addFields(
                    { name: 'Dice', value: `d${d1}: **${r1}** | d${d2}: **${r2}** = **${r1 + r2}**\nGate: ${gate} (miss if both ≤${gate})`, inline: false },
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
            initPlayer(userId, message.member.displayName);
            saveSnapshot(userId);
            const d = playerData.get(userId);
            const old = d.HP;
            
            if (args[0] === 'full') d.HP = d.maxHP;
            else if (args[0] === 'zero') d.HP = 0;
            else d.HP = Math.max(0, d.HP + parseInt(args[0]));
            
            const embed = new EmbedBuilder()
                .setColor(d.HP > old ? 0x00FF00 : 0xFF6B6B)
                .setTitle(d.characterName)
                .addFields({ name: `${EMOJIS.HP} HP`, value: `${old} → **${d.HP}**/${d.maxHP}`, inline: true });
            
            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }
        
        // $mp
        if (cmd === 'mp') {
            if (!args[0]) { await message.channel.send('Usage: `$mp <±amount|full|zero>`'); await del(); return; }
            const userId = message.author.id;
            initPlayer(userId, message.member.displayName);
            saveSnapshot(userId);
            const d = playerData.get(userId);
            const old = d.MP;
            
            if (args[0] === 'full') d.MP = d.maxMP;
            else if (args[0] === 'zero') d.MP = 0;
            else d.MP = Math.max(0, d.MP + parseInt(args[0]));
            
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
            initPlayer(userId, message.member.displayName);
            saveSnapshot(userId);
            const d = playerData.get(userId);
            const old = d.IP;
            
            if (args[0] === 'full') d.IP = d.maxIP;
            else if (args[0] === 'zero') d.IP = 0;
            else d.IP = Math.max(0, d.IP + parseInt(args[0]));
            
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
            initPlayer(userId, message.member.displayName);
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
            initPlayer(userId, message.member.displayName);
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
            initPlayer(userId, message.member.displayName);
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
            initPlayer(user.id, member.displayName);
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
            initPlayer(userId, message.member.displayName);
            saveSnapshot(userId);
            const d = playerData.get(userId);
            d.HP = d.maxHP;
            d.MP = d.maxMP;
            d.Armor = 0;
            d.Barrier = 0;
            
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
        
        // $ga <d1> <d2> <mod> <gate> [type]
        // FIX 2: targets removed — anyone can click Take Damage
        // NEW GATE RULE: miss only if BOTH dice roll at or below gate
        if (cmd === 'ga') {
            if (args.length < 4) {
                await message.channel.send('Usage: `$ga <d1> <d2> <mod> <gate> [type]`\n`a`=armor (default), `b`=barrier, `t`=true');
                await del();
                return;
            }
            
            const [d1, d2, mod, gate] = [parseInt(args[0]), parseInt(args[1]), parseInt(args[2]), parseInt(args[3])];
            
            let dmgType = 'armor';
            const last = args[args.length - 1].toLowerCase();
            if (last === 'a') dmgType = 'armor';
            else if (last === 'b') dmgType = 'barrier';
            else if (last === 't') dmgType = 'true';
            
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
                        { name: 'Dice', value: `d${d1}: **${r1}** | d${d2}: **${r2}** = **${r1 + r2}**\nGate: ${gate} (miss if both ≤${gate})`, inline: false },
                        { name: 'Damage', value: `HR = **${hr}**\n${hr} + ${mod} = **${dmg}**`, inline: false }
                    )
                    .setDescription(fumble ? '💀 **FUMBLE!**' : '❌ **MISS**');
                
                await message.channel.send({ embeds: [embed] });
                await del();
                return;
            }
            
            const typeLabel = dmgType === 'armor' ? 'Armor' : dmgType === 'barrier' ? 'Barrier' : 'True';
            const embed = new EmbedBuilder()
                .setColor(crit ? 0xFFD700 : 0xFF6B6B)
                .setTitle('🎲 GM Attack — HIT!')
                .addFields(
                    { name: 'Dice', value: `d${d1}: **${r1}** | d${d2}: **${r2}** = **${r1 + r2}**\nGate: ${gate} (miss if both ≤${gate})`, inline: false },
                    { name: 'Damage', value: `HR = **${hr}**\n${hr} + ${mod} = **${dmg}** ${typeLabel}`, inline: false }
                )
                .setDescription(crit ? '⭐ **CRITICAL!**' : '✅ **HIT!**')
                .setFooter({ text: 'Click Take Damage to apply — use $defend first to add defenses' });
            
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
                await message.channel.send(`⚔️ Clash started! ${EMOJIS.Overdrive} Overdrive reset to 0.`);
                await del();
                return;
            }
            
            if (sub === 'end') {
                encounter.active = false;
                encounter.combatants = [];
                encounter.turnsTaken = new Set();
                encounter.overdrive = 0;
                await message.channel.send('✅ Clash ended!');
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
                
                const dbData = await loadPlayerFromDB(userId);
                if (dbData) {
                    playerData.set(userId, dbData);
                } else {
                    initPlayer(userId, message.member.displayName);
                }
                
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
                        const dbData = await loadPlayerFromDB(userId);
                        if (dbData) {
                            playerData.set(userId, dbData);
                        } else {
                            const member = await message.guild.members.fetch(userId);
                            initPlayer(userId, member.displayName);
                        }
                        encounter.combatants.push(userId);
                        added++;
                    }
                }
                
                await message.channel.send(`✅ Added ${added} to clash!`);
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
                        lines.push(`**${num}.**${icon} **${d.characterName}**`);
                        lines.push(`${EMOJIS.HP} ${d.HP}/${d.maxHP} · ${EMOJIS.MP} ${d.MP}/${d.maxMP} · ${EMOJIS.IP} ${d.IP}/${d.maxIP}`);
                        lines.push(`${EMOJIS.Armor} ${d.Armor}/${d.maxArmor} · ${EMOJIS.Barrier} ${d.Barrier}/${d.maxBarrier}`);
                        lines.push('');
                        num++;
                    }
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
            
            await message.channel.send('Usage: `$clash <start|join|add|list|end>`');
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

        // $help
        if (cmd === 'help') {
            const embed = new EmbedBuilder()
                .setColor(0x00BFFF)
                .setTitle('📖 Eien Saga — Command Guide')
                .addFields(
                    { 
                        name: '🎮 Setup', 
                        value: '`$set <name> <hp> <mp> <ip> <armor> <barrier>`\nExample: `$set Gandalf 100 50 100 20 15`\n`$set <sheet_url>` — import from Google Sheets\n\n`$view` or `$view @player`', 
                        inline: false 
                    },
                    { 
                        name: '🎲 Dice Roller', 
                        value: '`$r <d1> <d2> [mod]` — sum of both dice + mod\nExample: `$r 6 6 2` = 2d6+2', 
                        inline: false 
                    },
                    { 
                        name: '⚔️ Attack (Player)', 
                        value: '`$a <d1> <d2> [mod] [gate]` — mod defaults 0, gate defaults 1\nMiss only if **both** dice roll at or below gate.\nExample: `$a 10 8` or `$a 10 8 5 2`', 
                        inline: false 
                    },
                    { 
                        name: '🎲 GM Attack', 
                        value: '`$ga <d1> <d2> <mod> <gate> [type]`\nExample: `$ga 10 8 15 1` or `$ga 10 8 15 1 b`\nMiss only if **both** dice roll at or below gate.\n**Types:** `a`=armor (default), `b`=barrier, `t`=true\nNo target needed — anyone in the channel can click **Take Damage**.', 
                        inline: false 
                    },
                    {
                        name: '💔 Apply Damage (Cascade)',
                        value: '`$dmg <amount> [a|b|t] [slot#...]`\nApplies damage through Armor/Barrier first, overflow hits HP.\nNo slots = targets yourself. Use clash slot numbers to target others.\nExample: `$dmg 20 a 1 3` (slots 1 & 3) · `$dmg 15 b` (self) · `$dmg 30 t 2`',
                        inline: false
                    },
                    {
                        name: '🎯 Random Target',
                        value: '`$random [count]` — pick random combatants from the clash\nExample: `$random 3` picks 3 distinct targets with slot numbers',
                        inline: false
                    },
                    { 
                        name: '💉 Resources', 
                        value: '`$hp`, `$mp`, `$ip`, `$armor`, `$barrier` — use `±amount`, `full`, or `zero`\nExample: `$hp -20` · `$mp +50` · `$armor full`\n\n`$defend` or `$d` — add max armor+barrier\n`$turn [@player]` — clear armor+barrier to 0\n`$rest` — HP/MP to max, armor/barrier to 0', 
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
                        value: '`$clash start` — start encounter (resets Overdrive, isolated to this channel)\n`$clash join` — add yourself\n`$clash add @players` — add others\n`$clash list` — show numbered combatants + Overdrive\n`$clash end` — end encounter\n\n`$round` — new round (clears armor/barrier, resets turns, **+1 Overdrive**)\n\nEach channel has its own independent clash. Use slot numbers from `$clash list` with `$dmg`.', 
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
        initPlayer(userId, member.displayName);

        if (!playerData.has(userId)) {
            await interaction.reply({ content: '❌ No character found. Use `$set` first.', ephemeral: true });
            return;
        }

        saveSnapshot(userId); // FIX 4: save snapshot so $undo works after button click
        const d = playerData.get(userId);

        const cascadeLines = applyDamageCascade(d, dmg, dmgType);

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
