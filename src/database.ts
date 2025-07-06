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


}

export const dbService = new DatabaseService(); 