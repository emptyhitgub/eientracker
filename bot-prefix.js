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
const activeEncounter = { active: false, combatants: [], turnsTaken: new Set(), overdrive: 0 };

const EMOJIS = { HP: '❤️', MP: '💧', IP: '💰', Armor: '🛡️', Barrier: '✨', Overdrive: '⚡' };
const MAX_OVERDRIVE = 6;

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

function getValueFromRange(data, cells) {
    for (const cell of cells) {
        const value = getCellValue(data, cell);
        if (value && !isNaN(parseInt(value))) {
            return parseInt(value);
        }
    }
    return 0;
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
        const maxHP = getValueFromRange(data, ['Q15', 'R15', 'S15', 'T15', 'Q16', 'R16']) || 100;
        const maxMP = getValueFromRange(data, ['Q18', 'R18', 'S18', 'T18', 'Q19', 'R19']) || 50;
        
        const baseIP = getValueFromRange(data, ['Q21', 'R21', 'S21', 'T21', 'Q22', 'R22', 'S22', 'T22']) || 0;
        const bonusIP = getValueFromRange(data, ['Q23', 'R23', 'S23', 'T23']) || 0;
        const maxIP = baseIP + bonusIP || 100;
        
        const maxArmor = getValueFromRange(data, ['AA15', 'AB15', 'AA16', 'AB16']) || 20;
        const maxBarrier = getValueFromRange(data, ['AA18', 'AB18', 'AA19', 'AB19']) || 15;
        
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
// Applies damage through Armor → HP (or Barrier → HP, or true damage)
// Returns a description of what happened for embed display
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
        // True damage — bypasses everything
        d.HP = Math.max(0, d.HP - dmg);
        lines.push(`💀 True damage bypasses defenses`);
        lines.push(`${EMOJIS.HP} HP: **${oldHP}** → **${d.HP}** (−${dmg})`);
    }

    return lines;
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

            if (!playerData.has(user.id)) {
                await message.channel.send(`❌ No character set for **${member.displayName}**. Use \`$set\` first.`);
                await del();
                return;
            }

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

        // ========================================
        // $dmg <amount> [a|b|t] [@target]
        // Applies damage through the cascade: Armor/Barrier absorbs, overflow hits HP
        // ========================================
        if (cmd === 'dmg') {
            if (!args[0] || isNaN(parseInt(args[0]))) {
                await message.channel.send('Usage: `$dmg <amount> [a|b|t] [@target]`\n`a`=armor (default), `b`=barrier, `t`=true\nExample: `$dmg 20 a` or `$dmg 15 b @player`');
                await del();
                return;
            }

            const dmg = parseInt(args[0]);
            const user = message.mentions.users.first() || message.author;
            const member = await message.guild.members.fetch(user.id);

            // Parse damage type — check args[1] if it's a type flag (not a mention)
            let dmgType = 'armor';
            if (args[1] && !args[1].startsWith('<@')) {
                const flag = args[1].toLowerCase();
                if (flag === 'b') dmgType = 'barrier';
                else if (flag === 't') dmgType = 'true';
            }

            if (!playerData.has(user.id)) {
                await message.channel.send(`❌ No character set for **${member.displayName}**. Use \`$set\` first.`);
                await del();
                return;
            }

            const d = playerData.get(user.id);
            const cascadeLines = applyDamageCascade(d, dmg, dmgType);

            const typeLabel = dmgType === 'armor' ? 'Armor' : dmgType === 'barrier' ? 'Barrier' : 'True';
            const embed = new EmbedBuilder()
                .setColor(0xFF6B6B)
                .setTitle(`💔 ${d.characterName} — ${dmg} ${typeLabel} Damage`)
                .setDescription(cascadeLines.join('\n'));

            if (d.HP === 0) embed.setFooter({ text: '💀 HP reached 0!' });

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
        
        // $hp
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

        // ========================================
        // $overdrive [±amount|zero]
        // Tracks the shared Overdrive pool (capped at MAX_OVERDRIVE)
        // With no args, shows current value
        // ========================================
        if (cmd === 'overdrive' || cmd === 'od') {
            if (!activeEncounter.active) {
                await message.channel.send('❌ No active clash. Use `$clash start` first.');
                await del();
                return;
            }

            const old = activeEncounter.overdrive;

            if (!args[0]) {
                // Just display
                const bar = buildOverdriveBar(old);
                const embed = new EmbedBuilder()
                    .setColor(0xFFAA00)
                    .setTitle(`${EMOJIS.Overdrive} Overdrive`)
                    .setDescription(`${bar}\n**${old} / ${MAX_OVERDRIVE}**`);
                await message.channel.send({ embeds: [embed] });
                await del();
                return;
            }

            if (args[0] === 'zero') {
                activeEncounter.overdrive = 0;
            } else {
                const delta = parseInt(args[0]);
                if (isNaN(delta)) {
                    await message.channel.send('Usage: `$overdrive [±amount|zero]`\nExample: `$overdrive +1`, `$overdrive -2`, `$overdrive zero`');
                    await del();
                    return;
                }
                activeEncounter.overdrive = Math.max(0, Math.min(MAX_OVERDRIVE, old + delta));
            }

            const newVal = activeEncounter.overdrive;
            const bar = buildOverdriveBar(newVal);
            const direction = newVal > old ? '📈' : newVal < old ? '📉' : '➡️';
            const embed = new EmbedBuilder()
                .setColor(newVal >= MAX_OVERDRIVE ? 0xFF4400 : 0xFFAA00)
                .setTitle(`${EMOJIS.Overdrive} Overdrive`)
                .setDescription(`${bar}\n**${old} → ${newVal} / ${MAX_OVERDRIVE}**`)
                .setFooter(newVal >= MAX_OVERDRIVE ? { text: '⚠️ Overdrive is maxed!' } : { text: `Changed by ${newVal - old > 0 ? '+' : ''}${newVal - old}` });

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
                    { name: '✅ Turns', value: 'Reset', inline: true },
                    { name: `${EMOJIS.Overdrive} Overdrive`, value: `**${activeEncounter.overdrive}** / ${MAX_OVERDRIVE} (unchanged)`, inline: true }
                );
            
            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }
        
        // $ga <d1> <d2> <mod> <gate> <@targets> [a|b|t]
        if (cmd === 'ga') {
            if (args.length < 5) {
                await message.channel.send('Usage: `$ga <d1> <d2> <mod> <gate> <@targets> [type]`\n`a`=armor (default), `b`=barrier, `t`=true');
                await del();
                return;
            }
            
            const [d1, d2, mod, gate] = [parseInt(args[0]), parseInt(args[1]), parseInt(args[2]), parseInt(args[3])];
            
            let dmgType = 'armor';
            const last = args[args.length - 1].toLowerCase();
            if (last === 'a') { dmgType = 'armor'; args.pop(); }
            else if (last === 'b') { dmgType = 'barrier'; args.pop(); }
            else if (last === 't') { dmgType = 'true'; args.pop(); }
            
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
                .setTitle('🎲 GM Attack — HIT!')
                .addFields(
                    { name: 'Dice', value: `d${d1}: **${r1}** | d${d2}: **${r2}** = **${r1 + r2}**\nGate: ≤${gate}`, inline: false },
                    { name: 'Damage', value: `HR = **${hr}**\n${hr} + ${mod} = **${dmg}**`, inline: false },
                    { name: 'Targets', value: targets.join(' '), inline: false }
                )
                .setDescription(crit ? '⭐ **CRITICAL!**' : '✅ **HIT!**')
                .setFooter({ text: `${dmg} ${dmgType} damage` });

            // Encode target IDs into the customId so the button handler can auth against them
            const targetIdStr = targetIds.join('-');
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`ga_defend_${dmg}_${dmgType}_${targetIdStr}_${message.id}`)
                    .setLabel('🛡️ Defend')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`ga_take_${dmg}_${dmgType}_${targetIdStr}_${message.id}`)
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
                activeEncounter.overdrive = 0;
                await message.channel.send(`⚔️ Clash started! ${EMOJIS.Overdrive} Overdrive reset to 0.`);
                await del();
                return;
            }
            
            if (sub === 'end') {
                activeEncounter.active = false;
                activeEncounter.combatants = [];
                activeEncounter.turnsTaken.clear();
                activeEncounter.overdrive = 0;
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
                
                const bar = buildOverdriveBar(activeEncounter.overdrive);
                
                const embed = new EmbedBuilder()
                    .setColor(0xFFAA00)
                    .setTitle('⚔️ Clash')
                    .setDescription(`${EMOJIS.Overdrive} **Overdrive:** ${bar} **${activeEncounter.overdrive}/${MAX_OVERDRIVE}**`)
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
                .setTitle('📖 Eien Saga — Command Guide')
                .addFields(
                    { 
                        name: '🎮 Setup', 
                        value: '`$set <name> <hp> <mp> <ip> <armor> <barrier>`\nExample: `$set Gandalf 100 50 100 20 15`\n`$set <sheet_url>` — import from Google Sheets\n\n`$view` or `$view @player`', 
                        inline: false 
                    },
                    { 
                        name: '⚔️ Attack (Player)', 
                        value: '`$a <dice1> <dice2> <modifier> <gate>`\nExample: `$a 10 8 5 1`', 
                        inline: false 
                    },
                    { 
                        name: '🎲 GM Attack', 
                        value: '`$ga <d1> <d2> <mod> <gate> @targets [type]`\nExample: `$ga 10 8 15 1 @Tank @DPS`\n**Types:** `a`=armor (default), `b`=barrier, `t`=true\nTargets click **Defend** or **Take Damage** — only tagged players can respond.', 
                        inline: false 
                    },
                    {
                        name: '💔 Apply Damage (Cascade)',
                        value: '`$dmg <amount> [a|b|t] [@target]`\nApplies damage through Armor/Barrier first, overflow hits HP.\nExample: `$dmg 20 a` or `$dmg 15 b @player` or `$dmg 30 t`',
                        inline: false
                    },
                    { 
                        name: '💉 Resources', 
                        value: '`$hp`, `$mp`, `$ip`, `$armor`, `$barrier` — use `±amount`, `full`, or `zero`\nExample: `$hp -20` · `$mp +50` · `$armor full`\n\n`$defend` — add max armor+barrier\n`$turn [@player]` — clear armor+barrier to 0\n`$rest` — HP/MP to max, armor/barrier to 0', 
                        inline: false 
                    },
                    {
                        name: `${EMOJIS.Overdrive} Overdrive (Shared Pool)`,
                        value: `\`$overdrive [±amount|zero]\` — adjust or view the shared Overdrive pool (max ${MAX_OVERDRIVE})\nAlias: \`$od\`\nExample: \`$od +1\` · \`$od -2\` · \`$od zero\`\nAlways visible in \`$clash list\`.`,
                        inline: false
                    },
                    { 
                        name: '⚔️ Clash', 
                        value: '`$clash start` — start encounter (resets Overdrive)\n`$clash join` — join yourself\n`$clash add @players` — add others\n`$clash list` — show all combatants + Overdrive\n`$clash end` — end encounter\n\n`$round` — new round (clears armor/barrier, resets turns)', 
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
// OVERDRIVE BAR HELPER
// ========================================
function buildOverdriveBar(current) {
    const filled = '🟧';
    const empty = '⬛';
    return filled.repeat(current) + empty.repeat(Math.max(0, MAX_OVERDRIVE - current));
}

// ========================================
// BUTTON HANDLER — $ga defend/take
// Auth: only tagged targets can respond
// customId format: ga_{action}_{dmg}_{dmgType}_{targetIds...}_{messageId}
// targetIds are joined with '-', messageId is always last
// ========================================
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    
    const parts = interaction.customId.split('_');
    if (parts[0] !== 'ga') return;
    
    try {
        // parts: [ga, action, dmg, dmgType, targetIdStr, messageId]
        const action = parts[1];
        const dmg = parseInt(parts[2]);
        const dmgType = parts[3];
        // parts[4] = hyphen-joined targetIds, parts[5] = messageId (ignored, just uniqueness)
        const targetIds = parts[4] ? parts[4].split('-') : [];

        // Auth check — only the actual targets can respond
        if (targetIds.length > 0 && !targetIds.includes(interaction.user.id)) {
            await interaction.reply({ content: '❌ This attack wasn\'t aimed at you.', ephemeral: true });
            return;
        }

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
        
        // Apply damage using the shared cascade helper
        const cascadeLines = applyDamageCascade(d, dmg, dmgType);

        if (isDefend) {
            // Show the defend boost that happened before damage
            if (dmgType === 'armor') {
                embed.addFields({ name: `${EMOJIS.Armor} Defended`, value: `${oldA} +${d.maxArmor - (d.Armor === 0 ? 0 : 0)} = boosted`, inline: true });
                embed.addFields({ name: `${EMOJIS.Barrier} Barrier`, value: `${oldB} +${d.maxBarrier} = boosted`, inline: true });
            } else if (dmgType === 'barrier') {
                embed.addFields({ name: `${EMOJIS.Armor} Armor`, value: `${oldA} +${d.maxArmor} = boosted`, inline: true });
                embed.addFields({ name: `${EMOJIS.Barrier} Defended`, value: `${oldB} +${d.maxBarrier} = boosted`, inline: true });
            } else {
                embed.addFields({ name: `${EMOJIS.Armor} Armor`, value: `${oldA} +${d.maxArmor} = boosted`, inline: true });
                embed.addFields({ name: `${EMOJIS.Barrier} Barrier`, value: `${oldB} +${d.maxBarrier} = boosted`, inline: true });
            }
        }

        embed.addFields({ name: 'Result', value: cascadeLines.join('\n'), inline: false });

        if (d.HP === 0) embed.setFooter({ text: '💀 HP reached 0!' });
        
        await interaction.reply({ embeds: [embed] });
    } catch (err) {
        console.error('Button error:', err);
        await interaction.reply({ content: '❌ Error', ephemeral: true });
    }
});

client.login(process.env.DISCORD_TOKEN);
