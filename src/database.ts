import sqlite3 from 'sqlite3';
import { promisify } from 'util';

export interface StoredChannel {
  id: string;
  name: string;
  type: string;
  is_private: boolean;
  is_archived: boolean;
  topic?: string;
  purpose?: string;
  num_members?: number;
  created: number;
  updated_at: number;
}

export interface StoredUser {
  id: string;
  name: string;
  display_name?: string;
  real_name?: string;
  email?: string;
  is_bot: boolean;
  is_deleted: boolean;
  profile_image?: string;
  timezone?: string;
  updated_at: number;
}

export interface ChannelMembership {
  channel_id: string;
  user_id: string;
  added_at: number;
}

export interface SlackToken {
  id?: number;
  team_id: string;
  team_name: string;
  user_id: string;
  user_name?: string;
  access_token: string;
  scope: string;
  token_type: string;
  created_at: number;
  updated_at: number;
  is_active: boolean;
}

export interface DMConversation {
  id: string;
  type: 'im' | 'mpim';
  user_id?: string; // For IM conversations, the other user's ID
  user_name?: string; // For IM conversations, the other user's name
  is_user_deleted?: boolean;
  created: number;
  updated_at: number;
  latest_message_ts?: string;
  unread_count?: number;
  is_open: boolean;
  priority?: number;
}

class DatabaseService {
  private db: sqlite3.Database;
  private initialized = false;

  constructor() {
    this.db = new sqlite3.Database('./slack_data.db');
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const run = promisify(this.db.run.bind(this.db));
    
    // Create channels table
    await run(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        is_private BOOLEAN NOT NULL,
        is_archived BOOLEAN NOT NULL,
        topic TEXT,
        purpose TEXT,
        num_members INTEGER,
        created INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Create users table
    await run(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        display_name TEXT,
        real_name TEXT,
        email TEXT,
        is_bot BOOLEAN NOT NULL,
        is_deleted BOOLEAN NOT NULL,
        profile_image TEXT,
        timezone TEXT,
        updated_at INTEGER NOT NULL
      )
    `);

    // Create channel_memberships table
    await run(`
      CREATE TABLE IF NOT EXISTS channel_memberships (
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, user_id),
        FOREIGN KEY (channel_id) REFERENCES channels(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    // Create slack_tokens table
    await run(`
      CREATE TABLE IF NOT EXISTS slack_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id TEXT NOT NULL,
        team_name TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT,
        access_token TEXT NOT NULL,
        scope TEXT NOT NULL,
        token_type TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT 1,
        UNIQUE(team_id, user_id)
      )
    `);

    // Create dm_conversations table for DM-specific data
    await run(`
      CREATE TABLE IF NOT EXISTS dm_conversations (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('im', 'mpim')),
        user_id TEXT,
        user_name TEXT,
        is_user_deleted BOOLEAN DEFAULT 0,
        created INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        latest_message_ts TEXT,
        unread_count INTEGER DEFAULT 0,
        is_open BOOLEAN DEFAULT 1,
        priority INTEGER DEFAULT 0
      )
    `);

    this.initialized = true;
  }

  async storeChannels(channels: StoredChannel[]): Promise<void> {
    await this.initialize();
    
    const run = promisify(this.db.run.bind(this.db));
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO channels 
      (id, name, type, is_private, is_archived, topic, purpose, num_members, created, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const channel of channels) {
      await new Promise((resolve, reject) => {
        stmt.run([
          channel.id,
          channel.name,
          channel.type,
          channel.is_private,
          channel.is_archived,
          channel.topic,
          channel.purpose,
          channel.num_members,
          channel.created,
          channel.updated_at
        ], (err) => {
          if (err) reject(err);
          else resolve(undefined);
        });
      });
    }
    
    stmt.finalize();
  }

  async storeUsers(users: StoredUser[]): Promise<void> {
    await this.initialize();
    
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO users 
      (id, name, display_name, real_name, email, is_bot, is_deleted, profile_image, timezone, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const user of users) {
      await new Promise((resolve, reject) => {
        stmt.run([
          user.id,
          user.name,
          user.display_name,
          user.real_name,
          user.email,
          user.is_bot,
          user.is_deleted,
          user.profile_image,
          user.timezone,
          user.updated_at
        ], (err) => {
          if (err) reject(err);
          else resolve(undefined);
        });
      });
    }
    
    stmt.finalize();
  }

  async storeChannelMemberships(memberships: ChannelMembership[]): Promise<void> {
    await this.initialize();
    
    const run = promisify(this.db.run.bind(this.db));
    
    // Clear existing memberships for channels being updated
    const channelIds = [...new Set(memberships.map(m => m.channel_id))];
    for (const channelId of channelIds) {
      await run('DELETE FROM channel_memberships WHERE channel_id = ?', [channelId]);
    }

    const stmt = this.db.prepare(`
      INSERT INTO channel_memberships (channel_id, user_id, added_at)
      VALUES (?, ?, ?)
    `);

    for (const membership of memberships) {
      await new Promise((resolve, reject) => {
        stmt.run([
          membership.channel_id,
          membership.user_id,
          membership.added_at
        ], (err) => {
          if (err) reject(err);
          else resolve(undefined);
        });
      });
    }
    
    stmt.finalize();
  }

  async getChannels(): Promise<StoredChannel[]> {
    await this.initialize();
    
    const all = promisify(this.db.all.bind(this.db));
    return await all('SELECT * FROM channels ORDER BY name');
  }

  // Get channels with member information included
  async getChannelsWithMembers(): Promise<any[]> {
    await this.initialize();
    
    const all = promisify(this.db.all.bind(this.db));
    
    // Get all channels first
    const channels = await all('SELECT * FROM channels ORDER BY name');
    
    // For each channel, get its members
    const channelsWithMembers = await Promise.all(
      channels.map(async (channel: any) => {
        const members = await all(`
          SELECT u.id, u.name, u.real_name, u.display_name 
          FROM users u
          JOIN channel_memberships cm ON u.id = cm.user_id
          WHERE cm.channel_id = ? AND u.is_deleted = 0
          ORDER BY u.name
        `, [channel.id]);
        
        return {
          id: channel.id,
          name: channel.name,
          type: channel.type,
          is_private: channel.is_private,
          is_archived: channel.is_archived,
          topic: channel.topic,
          purpose: channel.purpose,
          num_members: channel.num_members,
          created: channel.created,
          updated_at: channel.updated_at,
          members: members
        };
      })
    );
    
    return channelsWithMembers;
  }

  async getUsers(): Promise<StoredUser[]> {
    await this.initialize();
    
    const all = promisify(this.db.all.bind(this.db));
    return await all('SELECT * FROM users WHERE is_deleted = 0 ORDER BY name');
  }

  async getChannelMembers(channelId: string): Promise<StoredUser[]> {
    await this.initialize();
    
    const all = promisify(this.db.all.bind(this.db));
    return await all(`
      SELECT u.* FROM users u
      JOIN channel_memberships cm ON u.id = cm.user_id
      WHERE cm.channel_id = ? AND u.is_deleted = 0
      ORDER BY u.name
    `, [channelId]);
  }

  async getUserChannels(userId: string): Promise<StoredChannel[]> {
    await this.initialize();
    
    const all = promisify(this.db.all.bind(this.db));
    return await all(`
      SELECT c.* FROM channels c
      JOIN channel_memberships cm ON c.id = cm.channel_id
      WHERE cm.user_id = ? AND c.is_archived = 0
      ORDER BY c.name
    `, [userId]);
  }

  // Token management methods
  async storeToken(token: Omit<SlackToken, 'id'>): Promise<void> {
    await this.initialize();
    
    const run = promisify(this.db.run.bind(this.db));
    
    // First, deactivate any existing tokens for this team/user
    await run(`
      UPDATE slack_tokens 
      SET is_active = 0, updated_at = ? 
      WHERE team_id = ? AND user_id = ?
    `, [Date.now(), token.team_id, token.user_id]);
    
    // Insert the new token
    await run(`
      INSERT INTO slack_tokens 
      (team_id, team_name, user_id, user_name, access_token, scope, token_type, created_at, updated_at, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `, [
      token.team_id,
      token.team_name,
      token.user_id,
      token.user_name,
      token.access_token,
      token.scope,
      token.token_type,
      token.created_at,
      token.updated_at
    ]);
  }

  async getActiveToken(teamId?: string, userId?: string): Promise<SlackToken | null> {
    await this.initialize();
    
    const get = promisify(this.db.get.bind(this.db));
    
    let query = 'SELECT * FROM slack_tokens WHERE is_active = 1';
    const params: any[] = [];
    
    if (teamId && userId) {
      query += ' AND team_id = ? AND user_id = ?';
      params.push(teamId, userId);
    } else if (teamId) {
      query += ' AND team_id = ?';
      params.push(teamId);
    }
    
    query += ' ORDER BY updated_at DESC LIMIT 1';
    
    return await get(query, params);
  }

  async getAllTokens(): Promise<SlackToken[]> {
    await this.initialize();
    
    const all = promisify(this.db.all.bind(this.db));
    return await all('SELECT * FROM slack_tokens ORDER BY updated_at DESC');
  }

  async getActiveTokens(): Promise<SlackToken[]> {
    await this.initialize();
    
    const all = promisify(this.db.all.bind(this.db));
    return await all('SELECT * FROM slack_tokens WHERE is_active = 1 ORDER BY updated_at DESC');
  }

  async deactivateToken(tokenId: number): Promise<void> {
    await this.initialize();
    
    const run = promisify(this.db.run.bind(this.db));
    await run('UPDATE slack_tokens SET is_active = 0, updated_at = ? WHERE id = ?', [Date.now(), tokenId]);
  }

  async deleteToken(tokenId: number): Promise<void> {
    await this.initialize();
    
    const run = promisify(this.db.run.bind(this.db));
    await run('DELETE FROM slack_tokens WHERE id = ?', [tokenId]);
  }

  // DM conversation management methods
  async storeDMConversations(dms: DMConversation[]): Promise<void> {
    await this.initialize();
    
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO dm_conversations 
      (id, type, user_id, user_name, is_user_deleted, created, updated_at, latest_message_ts, unread_count, is_open, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const dm of dms) {
      await new Promise((resolve, reject) => {
        stmt.run([
          dm.id,
          dm.type,
          dm.user_id,
          dm.user_name,
          dm.is_user_deleted || false,
          dm.created,
          dm.updated_at,
          dm.latest_message_ts,
          dm.unread_count || 0,
          dm.is_open,
          dm.priority || 0
        ], (err) => {
          if (err) reject(err);
          else resolve(undefined);
        });
      });
    }
    
    stmt.finalize();
  }

  async getAllDMs(): Promise<DMConversation[]> {
    await this.initialize();
    
    const all = promisify(this.db.all.bind(this.db));
    return await all('SELECT * FROM dm_conversations ORDER BY priority DESC, updated_at DESC');
  }

  async getOpenDMs(): Promise<DMConversation[]> {
    await this.initialize();
    
    const all = promisify(this.db.all.bind(this.db));
    return await all('SELECT * FROM dm_conversations WHERE is_open = 1 ORDER BY priority DESC, updated_at DESC');
  }

  async getDMsByType(type: 'im' | 'mpim'): Promise<DMConversation[]> {
    await this.initialize();
    
    const all = promisify(this.db.all.bind(this.db));
    return await all('SELECT * FROM dm_conversations WHERE type = ? ORDER BY priority DESC, updated_at DESC', [type]);
  }

  async getDMConversation(dmId: string): Promise<DMConversation | null> {
    await this.initialize();
    
    const get = promisify(this.db.get.bind(this.db));
    return await get('SELECT * FROM dm_conversations WHERE id = ?', [dmId]);
  }

  async updateDMPriority(dmId: string, priority: number): Promise<void> {
    await this.initialize();
    
    const run = promisify(this.db.run.bind(this.db));
    await run('UPDATE dm_conversations SET priority = ?, updated_at = ? WHERE id = ?', [priority, Date.now(), dmId]);
  }
}

export const dbService = new DatabaseService(); 