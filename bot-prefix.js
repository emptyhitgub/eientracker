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

const EMOJIS = { HP: '❤️', MP: '💧', IP: '💰', Armor: '💥', Barrier: '🛡️' };

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
        // $set <name> <hp> <mp> <ip> <armor> <barrier>
        if (cmd === 'set') {
            const user = message.mentions.users.first() || message.author;
            const member = await message.guild.members.fetch(user.id);
            const offset = message.mentions.users.first() ? 1 : 0;
            
            if (args.length < 5 + offset) {
                await message.channel.send('Usage: `$set <name> <hp> <mp> <ip> <armor> <barrier>`\nExample: `$set Gandalf 100 50 100 20 15`');
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
        
        // $c <d1> <d2> <mod> <gate> [mp]
        if (cmd === 'c' || cmd === 'cast') {
            if (args.length < 4) {
                await message.channel.send('Usage: `$c <d1> <d2> <mod> <gate> [mp]`');
                await del();
                return;
            }
            
            const [d1, d2, mod, gate, mpCost] = [parseInt(args[0]), parseInt(args[1]), parseInt(args[2]), parseInt(args[3]), args[4] ? parseInt(args[4]) : 10];
            const userId = message.author.id;
            initPlayer(userId, message.member.displayName);
            const data = playerData.get(userId);
            
            if (data.MP < mpCost) {
                await message.channel.send(`❌ Not enough MP! Need ${mpCost}, have ${data.MP}`);
                await del();
                return;
            }
            
            data.MP -= mpCost;
            
            const r1 = Math.floor(Math.random() * d1) + 1;
            const r2 = Math.floor(Math.random() * d2) + 1;
            const hr = Math.max(r1, r2);
            const dmg = hr + mod;
            
            const fumble = r1 === 1 && r2 === 1;
            const crit = !fumble && r1 === r2 && r1 >= 6;
            const hit = fumble ? false : crit ? true : (r1 > gate && r2 > gate);
            
            const embed = new EmbedBuilder()
                .setColor(fumble ? 0x800000 : crit ? 0xFFD700 : hit ? 0x00FF00 : 0xFF0000)
                .setTitle(`✨ ${data.characterName}'s Cast`)
                .addFields(
                    { name: 'MP', value: `${data.MP + mpCost} → ${data.MP} (-${mpCost})`, inline: false },
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
        
        // $hp <amount|full|zero>
        if (cmd === 'hp') {
            if (!args[0]) { await message.channel.send('Usage: `$hp <amount|full|zero>`'); await del(); return; }
            const userId = message.author.id;
            initPlayer(userId, message.member.displayName);
            const d = playerData.get(userId);
            const old = d.HP;
            
            if (args[0] === 'full') d.HP = d.maxHP;
            else if (args[0] === 'zero') d.HP = 0;
            else d.HP = Math.max(0, Math.min(d.maxHP, d.HP + parseInt(args[0])));
            
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
            if (!args[0]) { await message.channel.send('Usage: `$mp <amount|full|zero>`'); await del(); return; }
            const userId = message.author.id;
            initPlayer(userId, message.member.displayName);
            const d = playerData.get(userId);
            const old = d.MP;
            
            if (args[0] === 'full') d.MP = d.maxMP;
            else if (args[0] === 'zero') d.MP = 0;
            else d.MP = Math.max(0, Math.min(d.maxMP, d.MP + parseInt(args[0])));
            
            const embed = new EmbedBuilder()
                .setColor(d.MP > old ? 0x00FF00 : 0xFF6B6B)
                .setTitle(d.characterName)
                .addFields({ name: `${EMOJIS.MP} MP`, value: `${old} → **${d.MP}**/${d.maxMP}`, inline: true });
            
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
            
            await message.channel.send(`🛡️ **${d.characterName}** defended!\n💥 Armor: ${oldA} +${d.maxArmor} = ${d.Armor}\n🛡️ Barrier: ${oldB} +${d.maxBarrier} = ${d.Barrier}`);
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
            
            await message.channel.send(`💨 **${d.characterName}** turn reset!\n💥 Armor: 0\n🛡️ Barrier: 0`);
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
            
            await message.channel.send(`✨ **${d.characterName}** rested!\n❤️ HP: ${d.HP}/${d.maxHP}\n💧 MP: ${d.MP}/${d.maxMP}`);
            await del();
            return;
        }
        
        // $gmattack <d1> <d2> <mod> <gate> <@targets> [armor|barrier|true]
        if (cmd === 'gmattack') {
            if (args.length < 5) {
                await message.channel.send('Usage: `$gmattack <d1> <d2> <mod> <gate> <@targets> [armor|barrier|true]`');
                await del();
                return;
            }
            
            const [d1, d2, mod, gate] = [parseInt(args[0]), parseInt(args[1]), parseInt(args[2]), parseInt(args[3])];
            
            let dmgType = 'armor';
            const last = args[args.length - 1].toLowerCase();
            if (last === 'armor' || last === 'barrier' || last === 'true') {
                dmgType = last;
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
                    .setCustomId(`gmattack_defend_${dmg}_${dmgType}_${message.id}`)
                    .setLabel('🛡️ Defend')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`gmattack_take_${dmg}_${dmgType}_${message.id}`)
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
                
                let list = '**Clash:**\n\n';
                for (const userId of activeEncounter.combatants) {
                    const d = playerData.get(userId);
                    if (d) {
                        const icon = activeEncounter.turnsTaken.has(userId) ? '✅' : '⬜';
                        list += `${icon} **${d.characterName}**\n❤️ ${d.HP}/${d.maxHP} | 💧 ${d.MP}/${d.maxMP} | 💥 ${d.Armor}/${d.maxArmor} | 🛡️ ${d.Barrier}/${d.maxBarrier}\n\n`;
                    }
                }
                
                await message.channel.send(list);
                await del();
                return;
            }
            
            await message.channel.send('Usage: `$clash <start|end|add|list>`');
            await del();
            return;
        }
        
        // $guide
        if (cmd === 'guide') {
            const embed = new EmbedBuilder()
                .setColor(0x00BFFF)
                .setTitle('📖 Commands')
                .addFields(
                    { name: 'Setup', value: '`$set <name> <hp> <mp> <ip> <armor> <barrier>`\n`$view` - View stats', inline: false },
                    { name: 'Combat', value: '`$a <d1> <d2> <mod> <gate>` - Attack\n`$c <d1> <d2> <mod> <gate> [mp]` - Cast\n`$hp/mp/armor/barrier <±amount|full|zero>`\n`$defend` `$turn` `$rest`', inline: false },
                    { name: 'GM', value: '`$gmattack <d1> <d2> <mod> <gate> <@targets> [type]`', inline: false },
                    { name: 'Clash', value: '`$clash start|end|add|list`', inline: false }
                );
            
            await message.channel.send({ embeds: [embed] });
            await del();
            return;
        }
        
    } catch (err) {
        console.error('Error:', err);
        await message.channel.send('❌ Error occurred.');
    }
});

// Button handler for gmattack
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    
    const parts = interaction.customId.split('_');
    if (parts[0] !== 'gmattack') return;
    
    try {
        const [, action, dmgStr, dmgType] = parts;
        const dmg = parseInt(dmgStr);
        
        const userId = interaction.user.id;
        const member = interaction.member;
        initPlayer(userId, member.displayName);
        const d = playerData.get(userId);
        
        const oldA = d.Armor, oldB = d.Barrier, oldHP = d.HP;
        let result = '';
        
        if (action === 'defend') {
            d.Armor += d.maxArmor;
            d.Barrier += d.maxBarrier;
            
            if (dmgType === 'armor') {
                const overflow = Math.max(0, dmg - d.Armor);
                d.Armor = Math.max(0, d.Armor - dmg);
                if (overflow > 0) {
                    d.HP = Math.max(0, d.HP - overflow);
                    result = `**${d.characterName}** DEFENDED!\n💥 Armor: ${oldA} +${d.maxArmor} = ${oldA + d.maxArmor} → ${d.Armor}\n🛡️ Barrier: ${oldB} +${d.maxBarrier} = ${d.Barrier}\n💔 Overflow: ${overflow} → HP: ${oldHP} → ${d.HP}`;
                } else {
                    result = `**${d.characterName}** DEFENDED!\n💥 Armor: ${oldA} +${d.maxArmor} = ${oldA + d.maxArmor} → ${d.Armor}\n🛡️ Barrier: ${oldB} +${d.maxBarrier} = ${d.Barrier}`;
                }
            } else if (dmgType === 'barrier') {
                const overflow = Math.max(0, dmg - d.Barrier);
                d.Barrier = Math.max(0, d.Barrier - dmg);
                if (overflow > 0) {
                    d.HP = Math.max(0, d.HP - overflow);
                    result = `**${d.characterName}** DEFENDED!\n💥 Armor: ${oldA} +${d.maxArmor} = ${d.Armor}\n🛡️ Barrier: ${oldB} +${d.maxBarrier} = ${oldB + d.maxBarrier} → ${d.Barrier}\n💔 Overflow: ${overflow} → HP: ${oldHP} → ${d.HP}`;
                } else {
                    result = `**${d.characterName}** DEFENDED!\n💥 Armor: ${oldA} +${d.maxArmor} = ${d.Armor}\n🛡️ Barrier: ${oldB} +${d.maxBarrier} = ${oldB + d.maxBarrier} → ${d.Barrier}`;
                }
            } else {
                d.HP = Math.max(0, d.HP - dmg);
                result = `**${d.characterName}** DEFENDED!\n💥 Armor: ${oldA} +${d.maxArmor} = ${d.Armor}\n🛡️ Barrier: ${oldB} +${d.maxBarrier} = ${d.Barrier}\n💔 True: ${dmg} → HP: ${oldHP} → ${d.HP}`;
            }
        } else {
            if (dmgType === 'armor') {
                const overflow = Math.max(0, dmg - d.Armor);
                d.Armor = Math.max(0, d.Armor - dmg);
                if (overflow > 0) {
                    d.HP = Math.max(0, d.HP - overflow);
                    result = `**${d.characterName}** took it!\n💥 Armor: ${oldA} → ${d.Armor}\n💔 Overflow: ${overflow} → HP: ${oldHP} → ${d.HP}`;
                } else {
                    result = `**${d.characterName}** took it!\n💥 Armor: ${oldA} → ${d.Armor}`;
                }
            } else if (dmgType === 'barrier') {
                const overflow = Math.max(0, dmg - d.Barrier);
                d.Barrier = Math.max(0, d.Barrier - dmg);
                if (overflow > 0) {
                    d.HP = Math.max(0, d.HP - overflow);
                    result = `**${d.characterName}** took it!\n🛡️ Barrier: ${oldB} → ${d.Barrier}\n💔 Overflow: ${overflow} → HP: ${oldHP} → ${d.HP}`;
                } else {
                    result = `**${d.characterName}** took it!\n🛡️ Barrier: ${oldB} → ${d.Barrier}`;
                }
            } else {
                d.HP = Math.max(0, d.HP - dmg);
                result = `**${d.characterName}** took it!\n💔 True: ${dmg} → HP: ${oldHP} → ${d.HP}`;
            }
        }
        
        await interaction.reply({ content: result });
    } catch (err) {
        console.error('Button error:', err);
        await interaction.reply({ content: '❌ Error', ephemeral: true });
    }
});

client.login(process.env.DISCORD_TOKEN);
