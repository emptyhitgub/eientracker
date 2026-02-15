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
const activeEncounter = { active: false, combatants: [], turnsTaken: new Set() };

const EMOJIS = { HP: '❤️', MP: '💧', IP: '💰', Armor: '🛡️', Barrier: '✨' };

function initPlayer(userId, username) {
    if (!playerData.has(userId)) {
        playerData.set(userId, {
            username, characterName: username,
            HP: 100, MP: 50, IP: 100, Armor: 0, Barrier: 0,
            maxHP: 100, maxMP: 50, maxIP: 100, maxArmor: 20, maxBarrier: 15
        });
    }
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
    const gidMatch = url.match(/[#&?]gid=([0-9]+)/); // Added ? for mobile URLs
    if (!spreadsheetMatch) return null;
    return { spreadsheetId: spreadsheetMatch[1], gid: gidMatch ? gidMatch[1] : '0' };
}

async function fetchSheetData(spreadsheetId, gid) {
    try {
        // Try method 1: Standard export with gid
        let url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
        let response = await fetch(url);
        
        // If that fails and gid is 0, try without gid parameter
        if (!response.ok && gid === '0') {
            url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv`;
            response = await fetch(url);
        }
        
        // If still fails, try the pub format
        if (!response.ok) {
            url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&gid=${gid}`;
            response = await fetch(url);
        }
        
        if (!response.ok) throw new Error('Sheet not accessible');
        const csvText = await response.text();
        
        // Check if we got HTML instead of CSV (means auth required)
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

// Get first non-empty value from a range of cells
function getValueFromRange(data, cells) {
    for (const cell of cells) {
        const value = getCellValue(data, cell);
        if (value && !isNaN(parseInt(value))) {
            return parseInt(value);
        }
    }
    return 0;
}

async function extractCharacterFromSheet(sheetUrl) {
    const parsed = parseSheetUrl(sheetUrl);
    if (!parsed) return { error: 'Invalid Google Sheets URL' };
    
    const data = await fetchSheetData(parsed.spreadsheetId, parsed.gid);
    if (!data) return { error: 'Could not fetch sheet. Make sure it\'s public (Anyone with link can view)' };
    
    try {
        // Read HP, MP from their ranges
        const maxHP = getValueFromRange(data, ['Q15', 'R15', 'S15', 'T15', 'Q16', 'R16']) || 100;
        const maxMP = getValueFromRange(data, ['Q18', 'R18', 'S18', 'T18', 'Q19', 'R19']) || 50;
        
        // IP = Base (Q21:T22) + Bonus (Q23:T23)
        const baseIP = getValueFromRange(data, ['Q21', 'R21', 'S21', 'T21', 'Q22', 'R22', 'S22', 'T22']) || 0;
        const bonusIP = getValueFromRange(data, ['Q23', 'R23', 'S23', 'T23']) || 0;
        const maxIP = baseIP + bonusIP || 100;
        
        // Armor and Barrier
        const maxArmor = getValueFromRange(data, ['AA15', 'AB15', 'AA16', 'AB16']) || 20;
        const maxBarrier = getValueFromRange(data, ['AA18', 'AB18', 'AA19', 'AB19']) || 15;
        
        // Stats - read from their ranges (S:T columns, rows 26-35)
        const force = getValueFromRange(data, ['T26', 'T27', 'S26', 'S27']) || 0;
        const mind = getValueFromRange(data, ['T28', 'T29', 'S28', 'S29']) || 0;
        const grace = getValueFromRange(data, ['T30', 'T31', 'S30', 'S31']) || 0;
        const soul = getValueFromRange(data, ['T32', 'T33', 'S32', 'S33']) || 0;
        const heart = getValueFromRange(data, ['T34', 'T35', 'S34', 'S35']) || 0;
        
        // Character name
        const characterName = getCellValue(data, 'E2') || getCellValue(data, 'F2') || getCellValue(data, 'E3') || getCellValue(data, 'F3') || 'Character';
        
        return { characterName, maxHP, maxMP, maxIP, maxArmor, maxBarrier, stats: { force, mind, grace, soul, heart } };
    } catch (error) {
        console.error('Error extracting character:', error);
        return { error: 'Error reading character data from sheet' };
    }
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
    
    const del = async () => { try { await message.delete(); } catch (e) {} };
    
    try {
        // $set <n> <hp> <mp> <ip> <armor> <barrier> OR $set <sheet_url>
        if (cmd === 'set') {
            const user = message.mentions.users.first() || message.author;
            const member = await message.guild.members.fetch(user.id);
            const offset = message.mentions.users.first() ? 1 : 0;
            
            // Check if first arg is a Google Sheets URL
            const firstArg = args[offset];
            if (firstArg && firstArg.includes('docs.google.com')) {
                await message.channel.send('📥 Importing character from Google Sheets...');
                
                const result = await extractCharacterFromSheet(firstArg);
                
                if (result.error) {
                    await message.channel.send(`❌ ${result.error}\n\n**Make sure:**\n- Sheet is public (Share → Anyone with link can view)\n- URL is correct\n\n**📱 Mobile users:** If using mobile link, try getting the link from PC with the specific tab open (will include \`#gid=NUMBERS\`)`);
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
            
            // Manual entry
            if (args.length < 5 + offset) {
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
            initPlayer(user.id, member.displayName);
            const d = playerData.get(user.id);
            
            const embed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle(`${d.characterName}`)
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
        
        // $a <d1> <d2> <mod> <gate>
        if (cmd === 'a' || cmd === 'attack') {
            if (args.length < 4) {
                await message.channel.send('Usage: `$a <d1> <d2> <mod> <gate>`');
                await del();
                return;
            }
            
            const [d1, d2, mod, gate] = [parseInt(args[0]), parseInt(args[1]), parseInt(args[2]), parseInt(args[3])];
            const userId = message.author.id;
            initPlayer(userId, message.member.displayName);
            const data = playerData.get(userId);
            
            const r1 = Math.floor(Math.random() * d1) + 1;
            const r2 = Math.floor(Math.random() * d2) + 1;
            const hr = Math.max(r1, r2);
            const dmg = hr + mod;
            
            const fumble = r1 === 1 && r2 === 1;
            const crit = !fumble && r1 === r2 && r1 >= 6;
            const hit = fumble ? false : crit ? true : (r1 > gate && r2 > gate);
            
            const embed = new EmbedBuilder()
                .setColor(fumble ? 0x800000 : crit ? 0xFFD700 : hit ? 0x00FF00 : 0xFF0000)
                .setTitle(`🎲 ${data.characterName}'s Attack`)
                .addFields(
                    { name: 'Dice', value: `d${d1}: **${r1}** | d${d2}: **${r2}** = **${r1 + r2}**\nGate: ≤${gate}`, inline: false },
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
        
        
        // $hp <±amount|full|zero>
        if (cmd === 'hp') {
            if (!args[0]) { await message.channel.send('Usage: `$hp <±amount|full|zero>`'); await del(); return; }
            const userId = message.author.id;
            initPlayer(userId, message.member.displayName);
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
        
        // $defend
        if (cmd === 'defend') {
            const userId = message.author.id;
            initPlayer(userId, message.member.displayName);
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
        
        // $round
        if (cmd === 'round') {
            if (!activeEncounter.active) {
                await message.channel.send('❌ No active clash. Use `$clash start`');
                await del();
                return;
            }
            
            let cleared = 0;
            for (const userId of activeEncounter.combatants) {
                const d = playerData.get(userId);
                if (d) {
                    d.Armor = 0;
                    d.Barrier = 0;
                    cleared++;
                }
            }
            
            activeEncounter.turnsTaken.clear();
            
            const embed = new EmbedBuilder()
                .setColor(0xFFAA00)
                .setTitle('🔄 New Round!')
                .setDescription(`Cleared **${cleared}** combatants`)
                .addFields(
                    { name: '🛡️ Armor', value: 'Set to **0**', inline: true },
                    { name: '✨ Barrier', value: 'Set to **0**', inline: true },
                    { name: '✅ Turns', value: 'Reset', inline: true }
                );
            
            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }
        
        // $ga <d1> <d2> <mod> <gate> <@targets> [a|b|t]
        if (cmd === 'ga') {
            if (args.length < 5) {
                await message.channel.send('Usage: `$ga <d1> <d2> <mod> <gate> <@targets> [a|b|t]`\n`a`=armor, `b`=barrier, `t`=true');
                await del();
                return;
            }
            
            const [d1, d2, mod, gate] = [parseInt(args[0]), parseInt(args[1]), parseInt(args[2]), parseInt(args[3])];
            
            let dmgType = 'armor';
            const last = args[args.length - 1].toLowerCase();
            if (last === 'a') {
                dmgType = 'armor';
                args.pop();
            } else if (last === 'b') {
                dmgType = 'barrier';
                args.pop();
            } else if (last === 't') {
                dmgType = 'true';
                args.pop();
            }
            
            const targets = message.content.match(/<@!?(\d+)>/g) || [];
            const targetIds = targets.map(m => m.match(/\d+/)[0]);
            
            if (targetIds.length === 0) {
                await message.channel.send('❌ No targets found. Mention with @player');
                await del();
                return;
            }
            
            const r1 = Math.floor(Math.random() * d1) + 1;
            const r2 = Math.floor(Math.random() * d2) + 1;
            const hr = Math.max(r1, r2);
            const dmg = hr + mod;
            
            const fumble = r1 === 1 && r2 === 1;
            const crit = !fumble && r1 === r2 && r1 >= 6;
            const hit = fumble ? false : crit ? true : (r1 > gate && r2 > gate);
            
            if (fumble || !hit) {
                const embed = new EmbedBuilder()
                    .setColor(fumble ? 0x800000 : 0xFF0000)
                    .setTitle('🎲 GM Attack')
                    .addFields(
                        { name: 'Dice', value: `d${d1}: **${r1}** | d${d2}: **${r2}** = **${r1 + r2}**\nGate: ≤${gate}`, inline: false },
                        { name: 'Damage', value: `HR = **${hr}**\n${hr} + ${mod} = **${dmg}**`, inline: false }
                    )
                    .setDescription(fumble ? '💀 **FUMBLE!**' : '❌ **MISS**');
                
                await message.channel.send({ embeds: [embed] });
                await del();
                return;
            }
            
            const embed = new EmbedBuilder()
                .setColor(crit ? 0xFFD700 : 0x00FF00)
                .setTitle('🎲 GM Attack - HIT!')
                .addFields(
                    { name: 'Dice', value: `d${d1}: **${r1}** | d${d2}: **${r2}** = **${r1 + r2}**\nGate: ≤${gate}`, inline: false },
                    { name: 'Damage', value: `HR = **${hr}**\n${hr} + ${mod} = **${dmg}**`, inline: false },
                    { name: 'Targets', value: targets.join(' '), inline: false }
                )
                .setDescription(crit ? '⭐ **CRITICAL!**' : '✅ **HIT!**')
                .setFooter({ text: `${dmg} ${dmgType} damage` });
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`ga_defend_${dmg}_${dmgType}_${message.id}`)
                    .setLabel('🛡️ Defend')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`ga_take_${dmg}_${dmgType}_${message.id}`)
                    .setLabel('💔 Take Damage')
                    .setStyle(ButtonStyle.Danger)
            );
            
            await message.channel.send({ content: `${targets.join(' ')} ⚔️ INCOMING!`, embeds: [embed], components: [row] });
            await del();
            return;
        }
        
        // $clash
        if (cmd === 'clash') {
            const sub = args[0]?.toLowerCase();
            
            if (sub === 'start') {
                activeEncounter.active = true;
                activeEncounter.combatants = [];
                activeEncounter.turnsTaken.clear();
                await message.channel.send('⚔️ Clash started!');
                await del();
                return;
            }
            
            if (sub === 'end') {
                activeEncounter.active = false;
                activeEncounter.combatants = [];
                activeEncounter.turnsTaken.clear();
                await message.channel.send('✅ Clash ended!');
                await del();
                return;
            }
            
            if (sub === 'join') {
                if (!activeEncounter.active) { await message.channel.send('❌ No clash. Use `$clash start`'); await del(); return; }
                
                const userId = message.author.id;
                
                if (activeEncounter.combatants.includes(userId)) {
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
                
                activeEncounter.combatants.push(userId);
                const d = playerData.get(userId);
                
                await message.channel.send(`✅ **${d.characterName}** joined the clash!`);
                await del();
                return;
            }
            
            if (sub === 'add') {
                if (!activeEncounter.active) { await message.channel.send('❌ No clash. Use `$clash start`'); await del(); return; }
                
                const mentioned = message.mentions.users;
                if (mentioned.size === 0) { await message.channel.send('❌ Mention players: `$clash add @player`'); await del(); return; }
                
                let added = 0;
                for (const [userId] of mentioned) {
                    if (!activeEncounter.combatants.includes(userId)) {
                        const dbData = await loadPlayerFromDB(userId);
                        if (dbData) {
                            playerData.set(userId, dbData);
                        } else {
                            const member = await message.guild.members.fetch(userId);
                            initPlayer(userId, member.displayName);
                        }
                        activeEncounter.combatants.push(userId);
                        added++;
                    }
                }
                
                await message.channel.send(`✅ Added ${added} to clash!`);
                await del();
                return;
            }
            
            if (sub === 'list') {
                if (!activeEncounter.active) { await message.channel.send('❌ No clash.'); await del(); return; }
                if (activeEncounter.combatants.length === 0) { await message.channel.send('⚔️ No combatants.'); await del(); return; }
                
                const embed = new EmbedBuilder()
                    .setColor(0xFFAA00)
                    .setTitle('⚔️ Clash Combatants')
                    .setTimestamp();
                
                for (const userId of activeEncounter.combatants) {
                    const d = playerData.get(userId);
                    if (d) {
                        const icon = activeEncounter.turnsTaken.has(userId) ? '✅' : '⬜';
                        const value = `${EMOJIS.HP} ${d.HP}/${d.maxHP} | ${EMOJIS.MP} ${d.MP}/${d.maxMP} | ${EMOJIS.IP} ${d.IP}/${d.maxIP}\n${EMOJIS.Armor} ${d.Armor}/${d.maxArmor} | ${EMOJIS.Barrier} ${d.Barrier}/${d.maxBarrier}`;
                        embed.addFields({ name: `${icon} ${d.characterName}`, value: value, inline: false });
                    }
                }
                
                await message.channel.send({ embeds: [embed] });
                await del();
                return;
            }
            
            await message.channel.send('Usage: `$clash <start|join|add|list|end>`');
            await del();
            return;
        }
        
        // $guide
        if (cmd === 'guide') {
            const embed = new EmbedBuilder()
                .setColor(0x00BFFF)
                .setTitle('📖 Command Guide')
                .setDescription('**Examples with actual values:**')
                .addFields(
                    { 
                        name: '🎮 Setup', 
                        value: '`$set <name> <hp> <mp> <ip> <armor> <barrier>`\nExample: `$set Gandalf 100 50 100 20 15`\n\n`$view` or `$view @player`', 
                        inline: false 
                    },
                    { 
                        name: '⚔️ Attack', 
                        value: '`$a <dice1> <dice2> <modifier> <gate>`\nExample: `$a 10 8 5 1`\n(Roll d10+d8, +5 modifier, gate ≤1)', 
                        inline: false 
                    },
                    { 
                        name: '💉 Resources (Can Exceed Max)', 
                        value: '`$hp <±amount|full|zero>` HP can go above max\n`$mp <±amount|full|zero>` MP can go above max\n`$ip <±amount|full|zero>`\n`$armor <±amount|full|zero>`\n`$barrier <±amount|full|zero>`\n\nExamples:\n`$hp -20` (lose 20)\n`$mp +50` (gain 50, can exceed max)\n`$armor full` (set to max)', 
                        inline: false 
                    },
                    { 
                        name: '🛡️ Quick Actions', 
                        value: '`$defend` - Add max armor+barrier to current\n`$turn` or `$turn @player` - Set armor/barrier to 0\n`$rest` - HP/MP to max, armor/barrier to 0\n`$round` - Clear everyone\'s armor/barrier to 0', 
                        inline: false 
                    },
                    { 
                        name: '🎲 GM Attack', 
                        value: '`$ga <d1> <d2> <mod> <gate> @targets [type]`\nExample: `$ga 10 8 15 1 @Tank @DPS`\nExample: `$ga 12 6 20 2 @Wizard b`\n\n**Types:** `a`=armor (default), `b`=barrier, `t`=true', 
                        inline: false 
                    },
                    { 
                        name: '⚔️ Clash', 
                        value: '`$clash start` - Start encounter\n`$clash join` - Join yourself\n`$clash add @players` - Add others\n`$clash list` - Show all (with IP!)\n`$clash end` - End encounter', 
                        inline: false 
                    }
                )
                .setFooter({ text: 'Tip: HP/MP can go above max | Use + or - for amounts' });
            
            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }
        
    } catch (err) {
        console.error('Error:', err);
        await message.channel.send('❌ Error occurred.');
    }
});

// Button handler for ga
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    
    const parts = interaction.customId.split('_');
    if (parts[0] !== 'ga') return;
    
    try {
        const [, action, dmgStr, dmgType] = parts;
        const dmg = parseInt(dmgStr);
        
        const userId = interaction.user.id;
        const member = interaction.member;
        initPlayer(userId, member.displayName);
        const d = playerData.get(userId);
        
        const oldA = d.Armor, oldB = d.Barrier, oldHP = d.HP;
        const isDefend = action === 'defend';
        
        const embed = new EmbedBuilder()
            .setColor(isDefend ? 0x00FF00 : 0xFF6B6B)
            .setTitle(`${isDefend ? '🛡️' : '💔'} ${d.characterName}`)
            .setDescription(isDefend ? '**DEFENDED!**' : '**Took the hit!**');
        
        if (isDefend) {
            d.Armor += d.maxArmor;
            d.Barrier += d.maxBarrier;
        }
        
        // Apply damage
        if (dmgType === 'armor') {
            const overflow = Math.max(0, dmg - d.Armor);
            d.Armor = Math.max(0, d.Armor - dmg);
            
            if (isDefend) {
                embed.addFields({ name: `${EMOJIS.Armor} Armor`, value: `${oldA} +${d.maxArmor} = ${oldA + d.maxArmor} → **${d.Armor}**`, inline: true });
                embed.addFields({ name: `${EMOJIS.Barrier} Barrier`, value: `${oldB} +${d.maxBarrier} = **${d.Barrier}**`, inline: true });
            } else {
                embed.addFields({ name: `${EMOJIS.Armor} Armor`, value: `${oldA} → **${d.Armor}**`, inline: true });
            }
            
            if (overflow > 0) {
                d.HP = Math.max(0, d.HP - overflow);
                embed.addFields({ name: '💔 Overflow', value: `${overflow} dmg → HP: ${oldHP} → **${d.HP}**`, inline: false });
            }
        } else if (dmgType === 'barrier') {
            const overflow = Math.max(0, dmg - d.Barrier);
            d.Barrier = Math.max(0, d.Barrier - dmg);
            
            if (isDefend) {
                embed.addFields({ name: `${EMOJIS.Armor} Armor`, value: `${oldA} +${d.maxArmor} = **${d.Armor}**`, inline: true });
                embed.addFields({ name: `${EMOJIS.Barrier} Barrier`, value: `${oldB} +${d.maxBarrier} = ${oldB + d.maxBarrier} → **${d.Barrier}**`, inline: true });
            } else {
                embed.addFields({ name: `${EMOJIS.Barrier} Barrier`, value: `${oldB} → **${d.Barrier}**`, inline: true });
            }
            
            if (overflow > 0) {
                d.HP = Math.max(0, d.HP - overflow);
                embed.addFields({ name: '💔 Overflow', value: `${overflow} dmg → HP: ${oldHP} → **${d.HP}**`, inline: false });
            }
        } else {
            // True damage
            d.HP = Math.max(0, d.HP - dmg);
            
            if (isDefend) {
                embed.addFields({ name: `${EMOJIS.Armor} Armor`, value: `${oldA} +${d.maxArmor} = **${d.Armor}**`, inline: true });
                embed.addFields({ name: `${EMOJIS.Barrier} Barrier`, value: `${oldB} +${d.maxBarrier} = **${d.Barrier}**`, inline: true });
            }
            
            embed.addFields({ name: '💔 True Damage', value: `${dmg} → HP: ${oldHP} → **${d.HP}**`, inline: false });
        }
        
        await interaction.reply({ embeds: [embed] });
    } catch (err) {
        console.error('Button error:', err);
        await interaction.reply({ content: '❌ Error', ephemeral: true });
    }
});

client.login(process.env.DISCORD_TOKEN);
