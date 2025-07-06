#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  InitializeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';
import { fetchLatestMessagesFromChannel, fetchThreadReplies, sendMessage, refreshAllSlackData } from './slack.js';
import { dbService, StoredChannel, StoredUser, ChannelMembership } from './database.js';

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
      },
      resources: {
        subscribe: false,
        listChanged: false
      },
      prompts: {
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
      },
      resources: {
        subscribe: false,
        listChanged: false
      },
      prompts: {
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

    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Helper function to get token and channel from environment variables
  const getTokenAndChannel = (args: any) => {
    const token = process.env.SLACK_BOT_TOKEN;
    const channel = args.channel || process.env.SLACK_DEFAULT_CHANNEL;
    
    if (!token) {
      throw new Error('SLACK_BOT_TOKEN environment variable is required.');
    }
    
    return { token, channel };
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
          const { token } = getTokenAndChannel({});
          
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
          
          // Store everything in parallel
          await Promise.all([
            dbService.storeChannels(storedChannels),
            dbService.storeUsers(storedUsers),
            dbService.storeChannelMemberships(memberships)
          ]);
          
          console.log('Database storage complete');
          
          return {
            content: [
              {
                type: 'text',
                text: `Successfully refreshed all Slack data:
              - ${storedChannels.length} conversations (channels/DMs)
              - ${storedUsers.length} unique users
              - ${memberships.length} memberships`
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
          const { token, channel } = getTokenAndChannel(args);
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
          const { token, channel } = getTokenAndChannel(args);
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
          const { token, channel } = getTokenAndChannel(args);
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

// RESOURCES - Slack-related static information
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  console.log('Resources/list request');
  return {
    resources: [
      {
        uri: 'slack://api-documentation',
        name: 'Slack API Documentation',
        description: 'Comprehensive guide to Slack Web API endpoints and best practices',
        mimeType: 'text/markdown'
      },
      {
        uri: 'slack://rate-limits',
        name: 'Slack API Rate Limits',
        description: 'Current rate limiting information for Slack API calls',
        mimeType: 'application/json'
      },
      {
        uri: 'slack://message-formatting',
        name: 'Slack Message Formatting Guide',
        description: 'How to format messages, use blocks, and create rich content',
        mimeType: 'text/markdown'
      }
    ]
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  console.log('Resources/read request:', request.params);
  const { uri } = request.params;

  switch (uri) {
    case 'slack://api-documentation':
      const apiDoc = `# Slack API Integration Guide

## Available Endpoints
This MCP server provides access to key Slack Web API functionality:

### Conversations API
- **conversations.list**: Get all channels accessible to the bot
- **conversations.history**: Retrieve message history from channels
- **conversations.replies**: Get thread replies for specific messages
- **conversations.members**: List channel members

### Chat API
- **chat.postMessage**: Send messages to channels or threads

### Users API
- **users.info**: Get user profile information

## Authentication
All tools require a Slack Bot Token (xoxb-...) with appropriate scopes:
- \`channels:read\` - Read public channel information
- \`groups:read\` - Read private channel information  
- \`im:read\` - Read direct messages
- \`chat:write\` - Send messages
- \`users:read\` - Read user information

## API Limitations
Non-Marketplace Slack apps have reduced API limits:
- **conversations.history**: 1 request per minute, max 15 messages
- **Rate limiting**: Tier 4 limits apply

*Last updated: ${new Date().toISOString()}*`;

      return {
        contents: [
          {
            uri,
            mimeType: 'text/markdown',
            text: apiDoc
          }
        ]
      };

    case 'slack://rate-limits':
      const rateLimits = {
        timestamp: new Date().toISOString(),
        api_tier: "Tier 4 (Non-Marketplace Apps)",
        limits: {
          conversations_history: {
            requests_per_minute: 1,
            max_messages_per_request: 15,
            note: "Severely limited for non-Marketplace apps as of May 2025"
          },
          conversations_list: {
            requests_per_minute: 20,
            max_channels_per_request: 1000
          },
          conversations_replies: {
            requests_per_minute: 50,
            max_replies_per_request: 1000
          },
          chat_postMessage: {
            requests_per_minute: 50,
            note: "Standard messaging rate limits"
          },
          users_info: {
            requests_per_minute: 100,
            note: "User lookup calls"
          }
        },
        best_practices: [
          "Cache channel lists to avoid repeated calls",
          "Batch user info requests where possible",
          "Use webhooks for real-time updates instead of polling",
          "Implement exponential backoff for rate limit errors"
        ]
      };

      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(rateLimits, null, 2)
          }
        ]
      };

    case 'slack://message-formatting':
      const formattingDoc = `# Slack Message Formatting Guide

## Basic Text Formatting
- **Bold**: \`*text*\` or \`**text**\`
- **Italic**: \`_text_\` or \`__text__\`
- **Strikethrough**: \`~text~\`
- **Code**: \`\\\`text\\\`\`
- **Code Block**: \`\\\`\\\`\\\`text\\\`\\\`\\\`\`

## Mentions
- **User**: \`<@USER_ID>\` or \`<@USER_ID|username>\`
- **Channel**: \`<#CHANNEL_ID>\` or \`<#CHANNEL_ID|channelname>\`
- **Everyone**: \`<!everyone>\`
- **Here**: \`<!here>\`

## Links
- **Auto-link**: URLs are automatically linked
- **Named link**: \`<URL|link text>\`
- **Email**: \`<mailto:email@example.com|email text>\`

## Threading
- **Reply to thread**: Use \`thread_ts\` parameter with parent message timestamp
- **Broadcast reply**: Set \`reply_broadcast: true\` to show in main channel

## Block Kit (Advanced)
Use the \`blocks\` parameter for rich formatting:
- Sections with text and accessories
- Buttons and interactive elements
- Dividers and context blocks
- File attachments and images

## Emoji
- **Standard**: \`:emoji_name:\`
- **Custom**: \`:custom_emoji:\`
- **Unicode**: Direct Unicode characters

*Formatting reference updated: ${new Date().toISOString()}*`;

      return {
        contents: [
          {
            uri,
            mimeType: 'text/markdown',
            text: formattingDoc
          }
        ]
      };

    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
});

// PROMPTS - Slack workflow templates
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  console.log('Prompts/list request');
  return {
    prompts: [
      {
        name: 'slack_team_standup',
        description: 'Generate a team standup template for Slack channels',
        arguments: [
          { name: 'team_name', description: 'Name of the team', required: true },
          { name: 'channel_id', description: 'Slack channel ID for standup', required: true },
          { name: 'frequency', description: 'Standup frequency (daily, weekly)', required: true },
          { name: 'timezone', description: 'Team timezone (e.g., PST, EST)', required: false }
        ]
      },
      {
        name: 'slack_incident_response',
        description: 'Create an incident response communication template',
        arguments: [
          { name: 'severity', description: 'Incident severity (low, medium, high, critical)', required: true },
          { name: 'incident_type', description: 'Type of incident', required: true },
          { name: 'response_channel', description: 'Dedicated incident response channel ID', required: true }
        ]
      },
      {
        name: 'slack_project_kickoff',
        description: 'Generate project kickoff communication template',
        arguments: [
          { name: 'project_name', description: 'Name of the project', required: true },
          { name: 'project_channel', description: 'Project channel ID', required: true },
          { name: 'stakeholders', description: 'Comma-separated list of stakeholder user IDs', required: true },
          { name: 'timeline', description: 'Project timeline', required: false }
        ]
      }
    ]
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  console.log('Prompts/get request:', request.params);
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'slack_team_standup':
      const standupArgs = args as { team_name?: string; channel_id?: string; frequency?: string; timezone?: string };
      const timezone = standupArgs.timezone || 'PST';
      
      return {
        description: `Team standup template for ${standupArgs.team_name} - ${standupArgs.frequency}`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `# ${standupArgs.team_name} ${standupArgs.frequency?.charAt(0).toUpperCase()}${standupArgs.frequency?.slice(1)} Standup

**Channel**: <#${standupArgs.channel_id}>
**Frequency**: ${standupArgs.frequency}
**Timezone**: ${timezone}

## Standup Format
Each team member should share:

### 🎯 **What I accomplished**
- Key tasks completed since last standup
- Major milestones reached

### 🚀 **What I'm working on today**
- Current priorities and focus areas
- Tasks planned for completion

### 🚧 **Blockers & Help needed**
- Any obstacles preventing progress
- Specific assistance requests

## Threading Guidelines
- Reply in thread for detailed discussions
- Keep main channel updates concise
- Use @here for urgent items requiring immediate attention

## Action Items
- Document any blockers in project management tool
- Schedule follow-up meetings for complex issues
- Update project status based on progress shared

*Template generated: ${new Date().toISOString()}*`
            }
          }
        ]
      };

    case 'slack_incident_response':
      const incidentArgs = args as { severity?: string; incident_type?: string; response_channel?: string };
      
      return {
        description: `Incident response template - ${incidentArgs.severity} severity ${incidentArgs.incident_type}`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `# 🚨 INCIDENT RESPONSE: ${incidentArgs.incident_type?.toUpperCase()}

**Severity**: ${incidentArgs.severity?.toUpperCase()}
**Response Channel**: <#${incidentArgs.response_channel}>
**Incident Started**: ${new Date().toISOString()}

## Immediate Actions Required

### 🔍 **Assessment Phase**
- [ ] Identify scope and impact
- [ ] Gather initial technical details  
- [ ] Determine customer impact level
- [ ] Assign incident commander

### 📢 **Communication Phase**
- [ ] Notify stakeholders in <#${incidentArgs.response_channel}>
- [ ] Update status page if customer-facing
- [ ] Prepare customer communication if needed
- [ ] Set up war room if critical

### 🛠️ **Resolution Phase**
- [ ] Deploy immediate mitigation if available
- [ ] Implement permanent fix
- [ ] Verify resolution and monitor
- [ ] Conduct post-incident review

## Key Contacts
- **Incident Commander**: TBD
- **Technical Lead**: TBD  
- **Communications Lead**: TBD
- **Customer Success**: TBD

## Timeline & Updates
Thread replies below with timestamp updates on progress.

*Incident template generated: ${new Date().toISOString()}*`
            }
          }
        ]
      };

    case 'slack_project_kickoff':
      const kickoffArgs = args as { project_name?: string; project_channel?: string; stakeholders?: string; timeline?: string };
      const stakeholderMentions = kickoffArgs.stakeholders ? 
        kickoffArgs.stakeholders.split(',').map(id => `<@${id.trim()}>`).join(' ') : 'TBD';
      
      return {
        description: `Project kickoff template for ${kickoffArgs.project_name}`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `# 🚀 PROJECT KICKOFF: ${kickoffArgs.project_name}

**Project Channel**: <#${kickoffArgs.project_channel}>
**Stakeholders**: ${stakeholderMentions}
**Timeline**: ${kickoffArgs.timeline || 'TBD'}
**Kickoff Date**: ${new Date().toLocaleDateString()}

## Project Overview
*[Add project description and objectives here]*

## Key Stakeholders & Roles
${stakeholderMentions}

## Success Criteria
- [ ] Define measurable objectives
- [ ] Establish key milestones
- [ ] Set quality standards
- [ ] Agree on delivery timeline

## Communication Plan
- **Daily Updates**: Progress shared in <#${kickoffArgs.project_channel}>
- **Weekly Reviews**: Status meetings scheduled
- **Milestone Reviews**: Stakeholder check-ins
- **Ad-hoc Updates**: Use threading for discussions

## Next Steps
1. **Requirements Gathering** - Finalize scope and specifications
2. **Resource Allocation** - Assign team members and roles  
3. **Timeline Planning** - Create detailed project schedule
4. **Kickoff Meeting** - Schedule alignment session

## Resources & Links
- Project documentation: *[Add link]*
- Meeting calendar: *[Add link]*
- File repository: *[Add link]*

Ready to make this project a success! 💪

*Project kickoff generated: ${new Date().toISOString()}*`
            }
          }
        ]
      };

    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
});

// Homepage - Slack OAuth Authorization
app.get('/', (req, res) => {
  const clientId = process.env.SLACK_CLIENT_ID || 'YOUR_CLIENT_ID';
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

  res.setHeader('Content-Type', 'text/html');
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Slack MCP Server - Connect to Slack</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { 
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
                max-width: 600px; 
                margin: 60px auto; 
                padding: 40px; 
                background: #f8f9fa; 
                text-align: center;
            }
            .container { 
                background: white; 
                padding: 40px; 
                border-radius: 12px; 
                box-shadow: 0 4px 20px rgba(0,0,0,0.1); 
            }
            h1 { 
                color: #4A154B; 
                margin-bottom: 20px; 
                font-size: 2.5em;
            }
            .subtitle {
                color: #666;
                font-size: 1.2em;
                margin-bottom: 30px;
            }
            .slack-btn { 
                display: inline-block; 
                padding: 16px 32px; 
                background: #4A154B; 
                color: #fff; 
                border-radius: 8px; 
                text-decoration: none; 
                font-size: 18px; 
                font-weight: bold;
                transition: background 0.3s;
                margin: 20px 0;
            }
            .slack-btn:hover { 
                background: #611f69; 
            }
            .info-box {
                background: #e3f2fd;
                padding: 20px;
                border-radius: 8px;
                margin: 30px 0;
                text-align: left;
            }
            .scopes {
                background: #f5f5f5;
                padding: 15px;
                border-radius: 6px;
                margin: 20px 0;
                font-family: monospace;
                font-size: 12px;
                text-align: left;
            }
            .step {
                margin: 15px 0;
                padding: 10px;
                border-left: 4px solid #4A154B;
                background: #fafafa;
            }
            .config-info {
                background: #fff3cd;
                border: 1px solid #ffeaa7;
                padding: 15px;
                border-radius: 6px;
                margin: 20px 0;
                font-size: 14px;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🚀 Slack MCP Server</h1>
            <p class="subtitle">Connect your Slack workspace to get started</p>
            
            <div class="info-box">
                <h3>📋 What This Does:</h3>
                <div class="step">1. Redirects you to Slack for authorization</div>
                <div class="step">2. You approve the requested permissions</div>
                <div class="step">3. Slack redirects back with your access token</div>
                <div class="step">4. Copy the token to use with MCP clients</div>
            </div>

            <a href="${slackAuthUrl}" class="slack-btn">
                📱 Connect to Slack
            </a>

            <div class="info-box">
                <h3>🔑 Requested Permissions:</h3>
                <div class="scopes">${scopes.split(',').join('<br>')}</div>
            </div>

            <div class="config-info">
                <strong>⚙️ Configuration:</strong><br>
                Client ID: <code>${clientId}</code><br>
                Redirect URI: <code>${redirectUri}</code><br>
                MCP Endpoint: <code>${req.protocol}://${req.get('host')}/mcp</code>
            </div>

            ${clientId === 'YOUR_CLIENT_ID' ? `
            <div style="background: #f8d7da; color: #721c24; padding: 15px; border-radius: 6px; margin: 20px 0;">
                <strong>⚠️ Setup Required:</strong><br>
                Please set your SLACK_CLIENT_ID environment variable before using OAuth.
            </div>
            ` : ''}
        </div>
    </body>
    </html>
  `);
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

// MCP endpoint using SDK transport
app.post('/mcp', async (req, res) => {
  console.log('MCP request received:', req.method, req.url);
  console.log('Headers:', req.headers);
  console.log('Body:', JSON.stringify(req.body));
  
  // Set timeouts
  req.setTimeout(25000); // 25 second request timeout
  res.setTimeout(25000); // 25 second response timeout
  
  try {
    // Create a fresh server instance for each request
    const requestServer = new Server(
      {
        name: 'slack-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {
            listChanged: false
          },
          resources: {
            subscribe: false,
            listChanged: false
          },
          prompts: {
            listChanged: false
          }
        },
      }
    );

    // Copy all handlers from the main server to this request server
    // INITIALIZATION handler
    requestServer.setRequestHandler(InitializeRequestSchema, async (request) => {
      console.log('Initialize request received:', JSON.stringify(request));
      return {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {
            listChanged: false
          },
          resources: {
            subscribe: false,
            listChanged: false
          },
          prompts: {
            listChanged: false
          }
        },
        serverInfo: {
          name: 'slack-mcp-server',
          version: '1.0.0'
        }
      };
    });

    // TOOLS handler
    requestServer.setRequestHandler(ListToolsRequestSchema, async () => {
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
        ]
      };
    });

    // CALL TOOL handler - copy the entire implementation
    requestServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      // Helper function to get token and channel from environment variables
      const getTokenAndChannel = (args: any) => {
        const token = process.env.SLACK_BOT_TOKEN;
        const channel = args.channel || process.env.SLACK_DEFAULT_CHANNEL;
        
        if (!token) {
          throw new Error('SLACK_BOT_TOKEN environment variable is required.');
        }
        
        return { token, channel };
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
              const { token } = getTokenAndChannel({});
              
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
              
              // Store everything in parallel
              await Promise.all([
                dbService.storeChannels(storedChannels),
                dbService.storeUsers(storedUsers),
                dbService.storeChannelMemberships(memberships)
              ]);
              
              console.log('Database storage complete');
              
              return {
                content: [
                  {
                    type: 'text',
                    text: `Successfully refreshed all Slack data:
              - ${storedChannels.length} conversations (channels/DMs)
              - ${storedUsers.length} unique users
              - ${memberships.length} memberships`
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
              const { token, channel } = getTokenAndChannel(args);
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
              const { token, channel } = getTokenAndChannel(args);
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
              const { token, channel } = getTokenAndChannel(args);
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

    // RESOURCES handler
    requestServer.setRequestHandler(ListResourcesRequestSchema, async () => {
      console.log('Resources/list request');
      return {
        resources: [
          {
            uri: 'slack://api-documentation',
            name: 'Slack API Documentation',
            description: 'Comprehensive guide to Slack Web API endpoints and best practices',
            mimeType: 'text/markdown'
          },
          {
            uri: 'slack://rate-limits',
            name: 'Slack API Rate Limits',
            description: 'Current rate limiting information for Slack API calls',
            mimeType: 'application/json'
          },
          {
            uri: 'slack://message-formatting',
            name: 'Slack Message Formatting Guide',
            description: 'How to format messages, use blocks, and create rich content',
            mimeType: 'text/markdown'
          }
        ]
      };
    });

    // Create a fresh transport for this request
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    });
    
    // Connect the fresh server to the fresh transport
    await requestServer.connect(transport);
    
    console.log('Handling request with fresh server and transport...');
    
    await transport.handleRequest(req, res, req.body);
    
    console.log('Request handled successfully');
    
    res.on('error', (error) => {
      console.error('Response error:', error);
    });
    
  } catch (error) {
    console.error('MCP transport error:', error);
    console.error('Error stack:', error.stack);
    
    // Send proper JSON-RPC error response
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { 
          code: -32603, 
          message: 'Internal server error',
          data: error.message
        },
        id: null
      });
    }
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// OAuth callback endpoint
app.get('/auth/slack/callback', async (req, res) => {
  const { code, error } = req.query;
  
  if (error) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html>
      <head>
          <title>Slack Authorization Error</title>
          <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 60px auto; padding: 40px; background: #f8f9fa; text-align: center; }
              .container { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
              .error { background: #f8d7da; color: #721c24; padding: 20px; border-radius: 8px; margin: 20px 0; }
          </style>
      </head>
      <body>
          <div class="container">
              <h1>❌ Authorization Error</h1>
              <div class="error">
                  <strong>Error:</strong> ${error}<br>
                  The Slack authorization was not completed successfully.
              </div>
              <a href="/">← Back to Authorization</a>
          </div>
      </body>
      </html>
    `);
  }

  if (!code) {
    return res.status(400).send('Missing authorization code');
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
    const userName = tokenData.authed_user?.id;

    if (!userToken) {
      throw new Error('No user access token received from Slack');
    }

    // Success page with token
    res.setHeader('Content-Type', 'text/html');
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
          <title>Slack Authorization Success</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
              body { 
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
                  max-width: 700px; 
                  margin: 60px auto; 
                  padding: 40px; 
                  background: #f8f9fa; 
                  text-align: center;
              }
              .container { 
                  background: white; 
                  padding: 40px; 
                  border-radius: 12px; 
                  box-shadow: 0 4px 20px rgba(0,0,0,0.1); 
              }
              h1 { 
                  color: #4A154B; 
                  margin-bottom: 20px; 
                  font-size: 2.5em;
              }
              .success { 
                  background: #d4edda; 
                  color: #155724; 
                  padding: 20px; 
                  border-radius: 8px; 
                  margin: 20px 0; 
              }
              .token-box {
                  background: #f8f9fa;
                  border: 2px solid #4A154B;
                  padding: 20px;
                  border-radius: 8px;
                  margin: 30px 0;
                  font-family: 'Monaco', 'Consolas', monospace;
                  word-break: break-all;
                  text-align: left;
                  position: relative;
              }
              .copy-btn {
                  position: absolute;
                  top: 10px;
                  right: 10px;
                  background: #4A154B;
                  color: white;
                  border: none;
                  padding: 8px 12px;
                  border-radius: 4px;
                  cursor: pointer;
                  font-size: 12px;
              }
              .copy-btn:hover {
                  background: #611f69;
              }
              .instructions {
                  background: #e3f2fd;
                  padding: 20px;
                  border-radius: 8px;
                  margin: 30px 0;
                  text-align: left;
              }
              .step {
                  margin: 10px 0;
                  padding: 8px;
                  border-left: 3px solid #4A154B;
                  background: #fafafa;
              }
          </style>
      </head>
      <body>
          <div class="container">
              <h1>🎉 Success!</h1>
              
              <div class="success">
                  <strong>✅ Slack Authorization Complete</strong><br>
                  Team: <strong>${teamName || 'Unknown'}</strong><br>
                  User: <strong>${userName || 'Unknown'}</strong>
              </div>

              <h2>📋 Your Slack Access Token</h2>
              <p>Copy this token to use with your MCP client:</p>
              
              <div class="token-box">
                  <button class="copy-btn" onclick="copyToken()">📋 Copy</button>
                  <div id="token">${userToken}</div>
              </div>

              <div class="instructions">
                  <h3>🔧 How to Use This Token:</h3>
                  <div class="step">1. Copy the token above</div>
                  <div class="step">2. Set it as SLACK_BOT_TOKEN in your environment</div>
                  <div class="step">3. Configure your MCP client to use: <code>${req.protocol}://${req.get('host')}/mcp</code></div>
                  <div class="step">4. Start using Slack tools in your MCP client!</div>
              </div>

              <p style="margin-top: 30px;">
                  <a href="/">← Authorize Another Account</a>
              </p>
          </div>

          <script>
              function copyToken() {
                  const tokenText = document.getElementById('token').textContent;
                  navigator.clipboard.writeText(tokenText).then(() => {
                      const btn = document.querySelector('.copy-btn');
                      const originalText = btn.textContent;
                      btn.textContent = '✅ Copied!';
                      btn.style.background = '#28a745';
                      setTimeout(() => {
                          btn.textContent = originalText;
                          btn.style.background = '#4A154B';
                      }, 2000);
                  }).catch(() => {
                      alert('Failed to copy token. Please select and copy manually.');
                  });
              }
          </script>
      </body>
      </html>
    `);

  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head>
          <title>Slack Authorization Error</title>
          <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 60px auto; padding: 40px; background: #f8f9fa; text-align: center; }
              .container { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
              .error { background: #f8d7da; color: #721c24; padding: 20px; border-radius: 8px; margin: 20px 0; }
          </style>
      </head>
      <body>
          <div class="container">
              <h1>❌ Authorization Error</h1>
              <div class="error">
                  <strong>Error:</strong> ${error.message}<br>
                  Please check your server configuration and try again.
              </div>
              <a href="/">← Back to Authorization</a>
          </div>
      </body>
      </html>
    `);
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