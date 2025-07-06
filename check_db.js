import sqlite3 from 'sqlite3';
import { promisify } from 'util';

async function checkDatabase() {
  const db = new sqlite3.Database('./slack_data.db');
  const all = promisify(db.all.bind(db));
  
  try {
    console.log('🔍 Checking Slack MCP Server Database...\n');
    
    // Check tokens table
    console.log('📋 SLACK TOKENS:');
    console.log('================');
    try {
      const tokens = await all('SELECT * FROM slack_tokens ORDER BY updated_at DESC');
      if (tokens.length === 0) {
        console.log('❌ No tokens found in database');
      } else {
        tokens.forEach((token, index) => {
          console.log(`Token ${index + 1}:`);
          console.log(`  ID: ${token.id}`);
          console.log(`  Team: ${token.team_name} (${token.team_id})`);
          console.log(`  User: ${token.user_name} (${token.user_id})`);
          console.log(`  Active: ${token.is_active ? '✅' : '❌'}`);
          console.log(`  Created: ${new Date(token.created_at).toLocaleString()}`);
          console.log(`  Updated: ${new Date(token.updated_at).toLocaleString()}`);
          console.log(`  Token: ${token.access_token.substring(0, 20)}...`);
          console.log('');
        });
      }
    } catch (error) {
      console.log('❌ Tokens table not found or error:', error.message);
    }
    
    // Check channels table
    console.log('📋 CHANNELS:');
    console.log('============');
    try {
      const channels = await all('SELECT COUNT(*) as count FROM channels');
      console.log(`Total channels: ${channels[0].count}`);
    } catch (error) {
      console.log('❌ Channels table not found or error:', error.message);
    }
    
    // Check users table
    console.log('\n📋 USERS:');
    console.log('==========');
    try {
      const users = await all('SELECT COUNT(*) as count FROM users');
      console.log(`Total users: ${users[0].count}`);
    } catch (error) {
      console.log('❌ Users table not found or error:', error.message);
    }
    
    // Check DM conversations table
    console.log('\n📋 DM CONVERSATIONS:');
    console.log('====================');
    try {
      const dms = await all('SELECT * FROM dm_conversations ORDER BY priority DESC, updated_at DESC');
      if (dms.length === 0) {
        console.log('❌ No DM conversations found');
      } else {
        console.log(`Total DM conversations: ${dms.length}`);
        dms.forEach((dm, index) => {
          console.log(`DM ${index + 1}:`);
          console.log(`  ID: ${dm.id}`);
          console.log(`  Type: ${dm.type}`);
          console.log(`  User: ${dm.user_name || 'Unknown'} (${dm.user_id || 'N/A'})`);
          console.log(`  Priority: ${dm.priority}`);
          console.log(`  Open: ${dm.is_open ? '✅' : '❌'}`);
          console.log('');
        });
      }
    } catch (error) {
      console.log('❌ DM conversations table not found or error:', error.message);
    }
    
  } catch (error) {
    console.error('❌ Database error:', error);
  } finally {
    db.close();
  }
}

checkDatabase().catch(console.error); 