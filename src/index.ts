#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  InitializeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';
import { fetchLatestMessagesFromChannel, fetchThreadReplies, sendMessage, refreshAllSlackData } from './slack.js';
import { dbService, StoredChannel, StoredUser, ChannelMembership, DMConversation } from './database.js';
import { renderHomepage, renderSuccess, renderError, renderConfigError } from './templates.js';

const app = express();
const PORT = process.env.PORT || 8080;

// Improve connection handling
app.use((req, res, next) => {
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=30, max=100');
  next();
});

// Enable CORS and JSON parsing
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id'],
}));
app.use(express.json());

// Create the MCP server
const server = new Server(
  {
    name: 'slack-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {
        listChanged: false
      }
    },
  }
);

// INITIALIZATION - Handle MCP initialization
server.setRequestHandler(InitializeRequestSchema, async (request) => {
  console.log('Initialize request received:', JSON.stringify(request));
  return {
    protocolVersion: '2024-11-05',
    capabilities: {
      tools: {
        listChanged: false
      }
    },
    serverInfo: {
      name: 'slack-mcp-server',
      version: '1.0.0'
    }
  };
});

// TOOLS - Slack integration functions
server.setRequestHandler(ListToolsRequestSchema, async () => {
  console.log('Tools/list request - sending Slack tool definitions');
  return {
    tools: [
      {
        name: 'ping',
        description: 'Simple connectivity test that responds immediately. Use this to verify MCP connection is working.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      {
        name: 'get_slack_channels',
        description: 'Retrieve all Slack channels/conversations from local storage including regular channels, private channels, DMs, and group DMs. Returns cached data for fast access. Each channel includes ID, name, type, privacy status, member count, topic, purpose, and all members (with their ID, name, real_name, display_name). Use refresh_all_slack_data first if you need current data from Slack.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      {
        name: 'refresh_all_slack_data',
        description: 'Comprehensive refresh that fetches all channels, extracts user profiles from channel memberships, and stores everything locally. This replaces separate channel/user refreshes with a single efficient operation. Calls Slack API to get: all conversations (channels/DMs/groups), member lists for each, and detailed user profiles (names, emails, timezones, roles). Stores channels, users, and membership relationships in local database.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      {
        name: 'get_slack_users',
        description: 'Retrieve all users from local storage with comprehensive profile information including display names, real names, email addresses, profile images, timezones, and role flags (bot, admin, owner, guest types). Only returns users discovered through channel memberships. Use refresh_all_slack_data to update user data.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      {
        name: 'get_channel_members',
        description: 'Get detailed member information for a specific channel from local storage. Returns user profiles for all members including names, roles, and profile data. Requires channel_id parameter. Use refresh_all_slack_data first to ensure current membership data.',
        inputSchema: {
          type: 'object',
          properties: {
            channel_id: {
              type: 'string',
              description: 'Slack channel ID (e.g., C1234567890) to retrieve members for. Find channel IDs using get_slack_channels.'
            }
          },
          required: ['channel_id']
        }
      },
      {
        name: 'get_channel_messages',
        description: 'Fetch recent messages from a Slack channel in real-time via Slack API (not cached). Returns up to 15 messages with full thread replies nested under parent messages. Includes message text, timestamps, user info, reactions, and rich formatting. Limited by Slack API rate limits for non-marketplace apps.',
        inputSchema: {
          type: 'object',
          properties: {
            channel: {
              type: 'string',
              description: 'Slack channel ID (e.g., C1234567890) to fetch messages from. If omitted, uses SLACK_DEFAULT_CHANNEL environment variable. Find channel IDs using get_slack_channels.'
            }
          },
          required: []
        }
      },
      {
        name: 'get_thread_replies',
        description: 'Retrieve all replies to a specific message thread in real-time via Slack API. Useful for getting complete conversation context around a threaded discussion. Returns chronological list of replies with user info, timestamps, and formatting.',
        inputSchema: {
          type: 'object',
          properties: {
            channel: {
              type: 'string',
              description: 'Slack channel ID containing the thread. If omitted, uses SLACK_DEFAULT_CHANNEL environment variable.'
            },
            thread_ts: {
              type: 'string',
              description: 'Timestamp of the parent message that started the thread (e.g., "1234567890.123456"). Get this from message timestamps in get_channel_messages results.'
            },
            limit: {
              type: 'number',
              description: 'Maximum number of replies to fetch (default: 50, max: 1000)',
              default: 50
            }
          },
          required: ['thread_ts']
        }
      },
      {
        name: 'send_slack_message',
        description: 'Send a message to a Slack channel or direct message to a user. Supports both channel IDs (C1234567890) and user IDs (U1234567890) for direct messages. Includes optional threading and formatting options.',
        inputSchema: {
          type: 'object',
          properties: {
            channel: {
              type: 'string',
              description: 'Slack channel ID (C1234567890) OR user ID (U1234567890) for direct message. If user ID provided, will automatically open/find DM channel. If omitted, uses SLACK_DEFAULT_CHANNEL environment variable. Find IDs using get_slack_channels or get_slack_users.'
            },
            text: {
              type: 'string',
              description: 'Message text to send. Supports Slack markdown formatting (bold, italic, links, mentions). Use <@USER_ID> for user mentions and <#CHANNEL_ID> for channel mentions.'
            },
            thread_ts: {
              type: 'string',
              description: 'Optional: Reply to this message timestamp to create a threaded reply. Get thread timestamps from get_channel_messages results.'
            },
            reply_broadcast: {
              type: 'boolean',
              description: 'Optional: When replying to a thread, also show the reply in the main channel (default: false)',
              default: false
            },
            unfurl_links: {
              type: 'boolean',
              description: 'Optional: Whether Slack should automatically expand links with previews (default: true)',
              default: true
            },
            unfurl_media: {
              type: 'boolean',
              description: 'Optional: Whether Slack should automatically expand media links with previews (default: true)',
              default: true
            }
          },
          required: ['text']
        }
      },
      {
        name: 'get_slack_dms',
        description: 'Retrieve one-on-one DM conversations from local storage. Returns cached IM (direct message) data with user information, open status, and priority ordering. Use refresh_all_slack_data to update DM data.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
        }
      },

    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Helper function to get token and channel from database and environment variables
  const getTokenAndChannel = async (args: any) => {
    // Try to get token from database first
    const dbToken = await dbService.getActiveToken();
    let token = dbToken?.access_token;
    
    // Fall back to environment variable if no database token found
    if (!token) {
      token = process.env.SLACK_BOT_TOKEN;
    }
    
    const channel = args.channel || process.env.SLACK_DEFAULT_CHANNEL;
    
    if (!token) {
      throw new Error('No Slack token available. Please authorize via OAuth or set SLACK_BOT_TOKEN environment variable.');
    }
    
    return { token, channel, tokenInfo: dbToken };
  };

  // Timeout wrapper to prevent hanging
  const executeWithTimeout = async (operation: () => Promise<any>, timeoutMs = 30000) => {
    return Promise.race([
      operation(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Operation timed out after 30 seconds')), timeoutMs)
      )
    ]);
  };

  try {
    console.log(`MCP Tool called: ${name}`, JSON.stringify(args));
    
    const result = await executeWithTimeout(async () => {
      switch (name) {
        case 'ping': {
          return {
            content: [
              {
                type: 'text',
                text: 'Pong!'
              }
            ]
          };
        }

        case 'get_slack_channels': {
          const channelsWithMembers = await dbService.getChannelsWithMembers();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(channelsWithMembers, null, 2)
              }
            ]
          };
        }

        case 'refresh_all_slack_data': {
          const { token } = await getTokenAndChannel({});
          
          console.log('Starting refresh_all_slack_data...');
          
          // Use the unified refresh function
          const result = await refreshAllSlackData(token);
          
          console.log('Data fetched, storing to database...');
          
          // Transform conversations to stored channel format
          const storedChannels: StoredChannel[] = result.conversations.map((channel: any) => ({
            id: channel.id,
            name: channel.name || '',
            type: channel.type || 'channel',
            is_private: channel.is_private || false,
            is_archived: channel.is_archived || false,
            topic: channel.topic?.value || '',
            purpose: channel.purpose?.value || '',
            num_members: channel.num_members || channel.member_ids?.length || 0,
            created: channel.created || Date.now() / 1000,
            updated_at: Date.now()
          }));
          
          // Transform users to stored format
          const storedUsers: StoredUser[] = result.users.map((user: any) => ({
            id: user.id,
            name: user.name || '',
            display_name: user.display_name || '',
            real_name: user.real_name || '',
            email: user.email || '',
            is_bot: user.is_bot || false,
            is_deleted: user.is_deleted || false,
            is_restricted: user.is_restricted || false,
            is_ultra_restricted: user.is_ultra_restricted || false,
            is_stranger: false, // Not available in Slack API
            is_app_user: user.is_app_user || false,
            is_external: false, // Not available in Slack API
            is_admin: user.is_admin || false,
            is_owner: user.is_owner || false,
            profile_image: user.profile_image || '',
            timezone: user.timezone || '',
            locale: user.locale || '',
            team_id: user.team_id || '',
            updated_at: user.updated_at || Date.now()
          }));
          
          // Create memberships
          const memberships: ChannelMembership[] = [];
          for (const channel of result.conversations) {
            if (channel.member_ids) {
              for (const userId of channel.member_ids) {
                memberships.push({
                  channel_id: channel.id,
                  user_id: userId,
                  added_at: Date.now()
                });
              }
            }
          }
          
          // Extract one-on-one DM conversations for dedicated DM storage
          // Get current user ID from token info first
          const tokenInfo = await getTokenAndChannel({});
          const currentUserId = tokenInfo.tokenInfo?.user_id;
          
          const dmConversations: DMConversation[] = result.conversations
            .filter((channel: any) => channel.type === 'im') // Only one-on-one DMs
            .map((dm: any) => {
              // Find the other user (not the current user)
              let otherUser = null;
              if (dm.member_ids && dm.member_ids.length === 2) {
                // Find the user who is not the current user
                otherUser = result.users.find((u: any) => 
                  dm.member_ids.includes(u.id) && u.id !== currentUserId
                );
              }
              
              // Set priority for specific DM (self-DM gets priority 100)
              let priority = 0;
              if (dm.id === 'D07EHJ1FCS0') {
                priority = 100;
              }
              
              return {
                id: dm.id,
                type: dm.type,
                user_id: otherUser?.id || null,
                user_name: otherUser?.display_name || otherUser?.real_name || otherUser?.name || null,
                is_user_deleted: otherUser?.is_deleted || false,
                created: dm.created || Date.now() / 1000,
                updated_at: Date.now(),
                latest_message_ts: dm.latest?.ts || null,
                unread_count: dm.unread_count || 0,
                is_open: dm.is_open !== false, // Default to true if not specified
                priority: priority
              };
            });
          
          // Store everything in parallel
          await Promise.all([
            dbService.storeChannels(storedChannels),
            dbService.storeUsers(storedUsers),
            dbService.storeChannelMemberships(memberships),
            dbService.storeDMConversations(dmConversations)
          ]);
          
          console.log('Database storage complete');
          
          return {
            content: [
              {
                type: 'text',
                text: `Successfully refreshed all Slack data:
              - ${storedChannels.length} conversations (channels/DMs)
              - ${storedUsers.length} unique users
              - ${memberships.length} memberships
              - ${dmConversations.length} one-on-one DMs stored separately`
              }
            ]
          };
        }

        case 'get_slack_users': {
          const users = await dbService.getUsers();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(users, null, 2)
              }
            ]
          };
        }

        case 'get_channel_members': {
          const { channel_id } = args as any;
          const members = await dbService.getChannelMembers(channel_id);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(members, null, 2)
              }
            ]
          };
        }

        case 'get_channel_messages': {
          const { token, channel } = await getTokenAndChannel(args);
          console.log(`Fetching messages from channel: ${channel}`);
          const result = await fetchLatestMessagesFromChannel(token, channel);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        }

        case 'get_thread_replies': {
          const { token, channel } = await getTokenAndChannel(args);
          const { thread_ts, limit = 50 } = args as any;
          console.log(`Fetching thread replies from ${channel}, thread: ${thread_ts}`);
          const result = await fetchThreadReplies(token, channel, thread_ts, limit);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        }

        case 'send_slack_message': {
          const { token, channel } = await getTokenAndChannel(args);
          const { text, thread_ts, reply_broadcast, unfurl_links, unfurl_media } = args as any;
          
          console.log(`Sending message to: ${channel}`);
          
          let targetChannel = channel;
          
          // Check if the channel looks like a user ID (starts with U)
          if (channel && channel.startsWith('U')) {
            console.log('User ID detected, finding DM channel...');
            // It's a user ID, find the DM channel from our stored data
            const channelsWithMembers = await dbService.getChannelsWithMembers();
            const dmChannel = channelsWithMembers.find(c => 
              c.type === 'im' && c.members.some(m => m.id === channel)
            );
            
            if (!dmChannel) {
              throw new Error(`No DM channel found with user ${channel}. Try running refresh_all_slack_data first, or use the actual DM channel ID.`);
            }
            
            targetChannel = dmChannel.id;
            console.log(`Found DM channel: ${targetChannel}`);
          }
          
          const result = await sendMessage(token, targetChannel, text, {
            thread_ts,
            reply_broadcast,
            unfurl_links,
            unfurl_media
          });
          
          console.log('Message sent successfully');
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        }

        case 'get_slack_dms': {
          // Only get one-on-one DMs (type 'im')
          const dms = await dbService.getDMsByType('im');
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(dms, null, 2)
              }
            ]
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });

    console.log(`MCP Tool completed: ${name}`);
    return result;

  } catch (error) {
    console.error(`MCP Tool error for ${name}:`, error);
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }
      ],
      isError: true
    };
  }
});

// MCP endpoint with stateless transport (no session management)
app.post('/mcp', async (req, res) => {
  const timestamp = new Date().toISOString();
  const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  console.log(`\n=== [${timestamp}] MCP REQUEST START [${requestId}] ===`);
  console.log(`Method: ${req.method}`);
  console.log(`URL: ${req.url}`);
  console.log(`Headers:`, JSON.stringify(req.headers, null, 2));
  console.log(`Body:`, JSON.stringify(req.body, null, 2));
  
  // Set timeouts
  req.setTimeout(25000); // 25 second request timeout
  res.setTimeout(25000); // 25 second response timeout
  
  console.log(`🚀 [${requestId}] Handling stateless MCP request`);
  
  try {
    console.log(`🔧 [${requestId}] Creating stateless StreamableHTTPServerTransport...`);
    
    // Create a stateless transport for this request
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    
    console.log(`🔗 [${requestId}] Connecting server to transport...`);
    
    // Connect the main server to this transport
    await server.connect(transport);
    
    console.log(`🎯 [${requestId}] Handling request via transport...`);
    
    // Handle the request
    await transport.handleRequest(req, res, req.body);
    
    console.log(`✨ [${requestId}] Request completed successfully`);
    
  } catch (error) {
    console.error(`❌ [${requestId}] Error handling request:`, error);
    console.error(`❌ [${requestId}] Error stack:`, error.stack);
    
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { 
          code: -32603, 
          message: 'Request handling failed',
          data: error.message
        },
        id: null
      });
    }
  }
  
  console.log(`=== [${new Date().toISOString()}] MCP REQUEST END [${requestId}] ===\n`);
});

// No session cleanup needed in stateless mode

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Debug endpoint to check database contents
app.get('/debug', async (req, res) => {
  try {
    const result: any = {
      timestamp: new Date().toISOString(),
      database: {}
    };

    // Check tokens
    try {
      const tokens = await dbService.getAllTokens();
      result.database.tokens = {
        count: tokens.length,
        active_count: tokens.filter(t => t.is_active).length,
        tokens: tokens.map(t => ({
          id: t.id,
          team_name: t.team_name,
          team_id: t.team_id,
          user_name: t.user_name,
          user_id: t.user_id,
          is_active: t.is_active,
          created_at: new Date(t.created_at).toISOString(),
          updated_at: new Date(t.updated_at).toISOString(),
          token_preview: t.access_token.substring(0, 20) + '...'
        }))
      };
    } catch (error) {
      result.database.tokens = { error: error.message };
    }

    // Check channels
    try {
      const channels = await dbService.getChannels();
      result.database.channels = {
        count: channels.length,
        sample: channels.slice(0, 5).map(c => ({
          id: c.id,
          name: c.name,
          type: c.type,
          is_private: c.is_private
        }))
      };
    } catch (error) {
      result.database.channels = { error: error.message };
    }

    // Check users
    try {
      const users = await dbService.getUsers();
      result.database.users = {
        count: users.length,
        sample: users.slice(0, 5).map(u => ({
          id: u.id,
          name: u.name,
          real_name: u.real_name,
          is_bot: u.is_bot
        }))
      };
    } catch (error) {
      result.database.users = { error: error.message };
    }

    // Check DM conversations
    try {
      const dms = await dbService.getAllDMs();
      result.database.dms = {
        count: dms.length,
        conversations: dms.map(dm => ({
          id: dm.id,
          type: dm.type,
          user_name: dm.user_name,
          user_id: dm.user_id,
          priority: dm.priority,
          is_open: dm.is_open
        }))
      };
    } catch (error) {
      result.database.dms = { error: error.message };
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: 'Database check failed',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Homepage - Slack OAuth Authorization
app.get('/', (req, res) => {
  const clientId = process.env.SLACK_CLIENT_ID;
  
  if (!clientId) {
    return res.send(renderConfigError());
  }
  
  const redirectUri = `${req.protocol}://${req.get('host')}/auth/slack/callback`;
  const scopes = [
    "channels:history",
    "channels:read", 
    "channels:write",
    "chat:write",
    "files:read",
    "groups:history",
    "groups:read",
    "groups:write", 
    "im:history",
    "im:read",
    "im:write",
    "links:read",
    "mpim:history",
    "mpim:read", 
    "mpim:write",
    "reactions:write",
    "users.profile:read",
    "users:read",
    "files:write"
  ].join(',');
  
  const slackAuthUrl = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&user_scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  const serverUrl = `${req.protocol}://${req.get('host')}`;
  
  res.send(renderHomepage(slackAuthUrl, serverUrl));
});

// Connection monitoring middleware
app.use('/mcp', (req, res, next) => {
  const startTime = Date.now();
  const connectionId = `${req.ip}-${startTime}`;
  
  console.log(`[${connectionId}] MCP Connection started from ${req.ip}`);
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    console.log(`[${connectionId}] MCP Connection finished in ${duration}ms`);
  });
  
  res.on('close', () => {
    const duration = Date.now() - startTime;
    console.log(`[${connectionId}] MCP Connection closed after ${duration}ms`);
  });
  
  next();
});

// OAuth callback endpoint
app.get('/auth/slack/callback', async (req, res) => {
  const { code, error } = req.query;
  
  if (error) {
    return res.status(400).send(
      renderError('Authorization Failed', `Slack returned an error: ${error}`)
    );
  }

  if (!code) {
    return res.status(400).send(
      renderError('No Authorization Code', 'The Slack authorization process was incomplete.')
    );
  }

  try {
    const clientId = process.env.SLACK_CLIENT_ID;
    const clientSecret = process.env.SLACK_CLIENT_SECRET;
    const redirectUri = `${req.protocol}://${req.get('host')}/auth/slack/callback`;

    if (!clientId || !clientSecret) {
      throw new Error('Missing SLACK_CLIENT_ID or SLACK_CLIENT_SECRET environment variables');
    }

    // Exchange authorization code for access token
    const tokenResponse = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: code as string,
        redirect_uri: redirectUri,
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenData.ok) {
      throw new Error(`Slack API error: ${tokenData.error}`);
    }

    // Get user token (this is what they'll use with MCP)
    const userToken = tokenData.authed_user?.access_token;
    const teamName = tokenData.team?.name;
    const teamId = tokenData.team?.id;
    const userId = tokenData.authed_user?.id;
    const userName = tokenData.authed_user?.name;
    const scope = tokenData.authed_user?.scope;

    if (!userToken || !teamId || !userId) {
      throw new Error('Incomplete token data received from Slack');
    }

    // Store the token in the database
    await dbService.storeToken({
      team_id: teamId,
      team_name: teamName || 'Unknown Team',
      user_id: userId,
      user_name: userName,
      access_token: userToken,
      scope: scope || '',
      token_type: 'user',
      created_at: Date.now(),
      updated_at: Date.now(),
      is_active: true
    });

    console.log(`Stored new Slack token for team ${teamName} (${teamId}) and user ${userName} (${userId})`);

    // Success page with token
    const serverUrl = `${req.protocol}://${req.get('host')}`;
    res.send(renderSuccess(userToken, serverUrl));

  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).send(
      renderError('Server Error', `Failed to process authorization: ${error.message}`)
    );
  }
});

async function main() {
  app.listen(PORT, () => {
    console.log(`🚀 Slack MCP Server running on port ${PORT}`);
    console.log(`📡 MCP endpoint: http://localhost:${PORT}/mcp`);
    console.log(`❤️ Health check: http://localhost:${PORT}/health`);
    console.log(`🏠 Homepage: http://localhost:${PORT}/`);
  });
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});