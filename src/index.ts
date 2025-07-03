#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';
import { fetchChannels, fetchLatestMessagesFromChannel, fetchThreadReplies, sendMessage, fetchUsers, fetchChannelsWithMembers } from './slack.js';
import { dbService, StoredChannel, StoredUser, ChannelMembership } from './database.js';

const app = express();
const PORT = process.env.PORT || 8080;

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

// TOOLS - Slack integration functions
server.setRequestHandler(ListToolsRequestSchema, async () => {
  console.log('Tools/list request - sending Slack tool definitions');
  return {
    tools: [
      {
        name: 'get_slack_channels',
        description: 'Get list of Slack channels from local storage (fast). Use refresh_channel_data first if data might be stale.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      {
        name: 'refresh_channel_data',
        description: 'Refresh channel data from Slack API and store locally. Fetches channels, users, and memberships.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      {
        name: 'refresh_user_data',
        description: 'Refresh user data from Slack API and store locally. Updates user profiles and information.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      {
        name: 'get_slack_users',
        description: 'Get list of Slack users from local storage with names, display names, and profile info.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      {
        name: 'get_channel_members',
        description: 'Get detailed member list for a specific channel from local storage.',
        inputSchema: {
          type: 'object',
          properties: {
            channel_id: {
              type: 'string',
              description: 'Channel ID to get members for'
            }
          },
          required: ['channel_id']
        }
      },
      {
        name: 'get_channel_messages',
        description: 'Get latest messages from a Slack channel with nested thread replies. Uses SLACK_BOT_TOKEN from environment.',
        inputSchema: {
          type: 'object',
          properties: {
            channel: {
              type: 'string',
              description: 'Channel ID (e.g., C1234567890). If not provided, will use SLACK_DEFAULT_CHANNEL environment variable.'
            }
          },
          required: []
        }
      },
      {
        name: 'get_thread_replies',
        description: 'Get all replies to a specific message thread. Uses SLACK_BOT_TOKEN from environment.',
        inputSchema: {
          type: 'object',
          properties: {
            channel: {
              type: 'string',
              description: 'Channel ID (e.g., C1234567890). If not provided, will use SLACK_DEFAULT_CHANNEL environment variable.'
            },
            thread_ts: {
              type: 'string',
              description: 'Timestamp of the parent message to get replies for'
            },
            limit: {
              type: 'number',
              description: 'Maximum number of replies to fetch (default: 50)',
              default: 50
            }
          },
          required: ['thread_ts']
        }
      },
      {
        name: 'send_slack_message',
        description: 'Send a message to a Slack channel. Uses SLACK_BOT_TOKEN from environment.',
        inputSchema: {
          type: 'object',
          properties: {
            channel: {
              type: 'string',
              description: 'Channel ID (e.g., C1234567890). If not provided, will use SLACK_DEFAULT_CHANNEL environment variable.'
            },
            text: {
              type: 'string',
              description: 'Message text to send'
            },
            thread_ts: {
              type: 'string',
              description: 'Timestamp of parent message if replying to a thread (optional)'
            },
            reply_broadcast: {
              type: 'boolean',
              description: 'Whether to broadcast thread reply to the main channel (optional)',
              default: false
            },
            unfurl_links: {
              type: 'boolean',
              description: 'Whether to auto-expand links (optional)',
              default: true
            },
            unfurl_media: {
              type: 'boolean',
              description: 'Whether to auto-expand media (optional)',
              default: true
            }
          },
          required: ['text']
        }
      }
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

  try {
    switch (name) {
      case 'get_slack_channels': {
        const channels = await dbService.getChannels();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(channels, null, 2)
            }
          ]
        };
      }

      case 'refresh_channel_data': {
        const { token } = getTokenAndChannel({});
        
        // Fetch channels with member IDs
        const channels = await fetchChannelsWithMembers(token);
        
        // Transform to stored format
        const storedChannels: StoredChannel[] = channels.map((channel: any) => ({
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
        
        // Store channels
        await dbService.storeChannels(storedChannels);
        
        // Create memberships
        const memberships: ChannelMembership[] = [];
        for (const channel of channels) {
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
        
        // Store memberships
        await dbService.storeChannelMemberships(memberships);
        
        return {
          content: [
            {
              type: 'text',
              text: `Successfully refreshed ${storedChannels.length} channels and ${memberships.length} memberships`
            }
          ]
        };
      }

      case 'refresh_user_data': {
        const { token } = getTokenAndChannel({});
        
        // Fetch all users
        const users = await fetchUsers(token);
        
        // Transform to stored format
        const storedUsers: StoredUser[] = users.map((user: any) => ({
          id: user.id,
          name: user.name || '',
          display_name: user.profile?.display_name || '',
          real_name: user.profile?.real_name || '',
          email: user.profile?.email || '',
          is_bot: user.is_bot || false,
          is_deleted: user.deleted || false,
          profile_image: user.profile?.image_72 || '',
          timezone: user.tz || '',
          updated_at: Date.now()
        }));
        
        // Store users
        await dbService.storeUsers(storedUsers);
        
        return {
          content: [
            {
              type: 'text',
              text: `Successfully refreshed ${storedUsers.length} users`
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
        const result = await sendMessage(token, channel, text, {
          thread_ts,
          reply_broadcast,
          unfurl_links,
          unfurl_media
        });
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
  } catch (error) {
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Homepage
app.get('/', (req, res) => {
  const currentToken = process.env.SLACK_BOT_TOKEN ? 'Set' : 'Not Set';
  const currentChannel = process.env.SLACK_DEFAULT_CHANNEL || 'Not Set';
  
  res.setHeader('Content-Type', 'text/html');
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Slack MCP Server Configuration</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { 
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
                max-width: 800px; 
                margin: 40px auto; 
                padding: 20px; 
                background: #f8f9fa; 
            }
            .container { 
                background: white; 
                padding: 30px; 
                border-radius: 8px; 
                box-shadow: 0 2px 10px rgba(0,0,0,0.1); 
            }
            h1 { color: #333; margin-bottom: 30px; }
            .status { 
                background: #e3f2fd; 
                padding: 15px; 
                border-radius: 6px; 
                margin-bottom: 25px; 
                border-left: 4px solid #2196f3; 
            }
            .form-group { margin-bottom: 20px; }
            label { 
                display: block; 
                margin-bottom: 8px; 
                font-weight: 600; 
                color: #555; 
            }
            input[type="text"], input[type="password"] { 
                width: 100%; 
                padding: 12px; 
                border: 2px solid #ddd; 
                border-radius: 6px; 
                font-size: 14px; 
                box-sizing: border-box;
            }
            input:focus { 
                outline: none; 
                border-color: #4CAF50; 
            }
            button { 
                background: #4CAF50; 
                color: white; 
                padding: 12px 24px; 
                border: none; 
                border-radius: 6px; 
                cursor: pointer; 
                font-size: 16px; 
                margin-right: 10px; 
            }
            button:hover { background: #45a049; }
            .refresh-btn { background: #2196F3; }
            .refresh-btn:hover { background: #1976D2; }
            .help-text { 
                font-size: 12px; 
                color: #666; 
                margin-top: 5px; 
            }
            .success { 
                background: #d4edda; 
                color: #155724; 
                padding: 10px; 
                border-radius: 4px; 
                margin: 10px 0; 
            }
            .error { 
                background: #f8d7da; 
                color: #721c24; 
                padding: 10px; 
                border-radius: 4px; 
                margin: 10px 0; 
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🔧 Slack MCP Server Configuration</h1>
            
            <div class="status">
                <h3>Current Status</h3>
                <p><strong>Slack Bot Token:</strong> ${currentToken}</p>
                <p><strong>Default Channel:</strong> ${currentChannel}</p>
                <p><strong>MCP Endpoint:</strong> <code>${req.get('host')}/mcp</code></p>
            </div>

            <form action="/configure" method="post" style="margin-bottom: 20px;">
                <div class="form-group">
                    <label for="token">Slack Bot Token (xoxb-...)</label>
                    <input type="password" id="token" name="token" placeholder="Enter your Slack bot token">
                    <div class="help-text">
                        Get this from your Slack app's OAuth & Permissions page. Required scopes: 
                        channels:read, channels:history, chat:write, users:read
                    </div>
                </div>
                
                <div class="form-group">
                    <label for="channel">Default Channel ID (optional)</label>
                    <input type="text" id="channel" name="channel" placeholder="C1234567890" value="${currentChannel !== 'Not Set' ? currentChannel : ''}">
                    <div class="help-text">
                        Optional default channel for operations. You can still specify channels in individual tool calls.
                    </div>
                </div>
                
                <button type="submit">💾 Save Configuration</button>
            </form>

            <div style="border-top: 1px solid #eee; padding-top: 20px;">
                <h3>Data Management</h3>
                <p>After configuring your token, refresh the local data cache:</p>
                <button onclick="refreshData('channels')" class="refresh-btn">🔄 Refresh Channel Data</button>
                <button onclick="refreshData('users')" class="refresh-btn">👥 Refresh User Data</button>
            </div>

            <div id="message"></div>
        </div>

        <script>
            async function refreshData(type) {
                const messageDiv = document.getElementById('message');
                messageDiv.innerHTML = '<div class="status">Refreshing ' + type + ' data...</div>';
                
                try {
                    const response = await fetch('/refresh/' + type, { method: 'POST' });
                    const result = await response.text();
                    
                    if (response.ok) {
                        messageDiv.innerHTML = '<div class="success">✅ ' + result + '</div>';
                    } else {
                        messageDiv.innerHTML = '<div class="error">❌ ' + result + '</div>';
                    }
                } catch (error) {
                    messageDiv.innerHTML = '<div class="error">❌ Error: ' + error.message + '</div>';
                }
            }

            // Handle form submission
            const form = document.querySelector('form');
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const formData = new FormData(form);
                const messageDiv = document.getElementById('message');
                
                try {
                    const response = await fetch('/configure', {
                        method: 'POST',
                        body: formData
                    });
                    const result = await response.text();
                    
                    if (response.ok) {
                        messageDiv.innerHTML = '<div class="success">✅ ' + result + '</div>';
                        setTimeout(() => location.reload(), 1500);
                    } else {
                        messageDiv.innerHTML = '<div class="error">❌ ' + result + '</div>';
                    }
                } catch (error) {
                    messageDiv.innerHTML = '<div class="error">❌ Error: ' + error.message + '</div>';
                }
            });
        </script>
    </body>
    </html>
  `);
});

app.post('/configure', express.urlencoded({ extended: true }), (req, res) => {
  const { token, channel } = req.body;
  
  if (!token || !token.startsWith('xoxb-')) {
    return res.status(400).send('Valid Slack bot token is required (must start with xoxb-)');
  }
  
  // Note: In production, you'd want to store these securely
  // For now, we'll just indicate success but note they need to be set in environment
  res.send(`Configuration received! Please set these environment variables:
    SLACK_BOT_TOKEN=${token}
    ${channel ? `SLACK_DEFAULT_CHANNEL=${channel}` : ''}
    
    Then restart the server for changes to take effect.`);
});

app.post('/refresh/channels', async (req, res) => {
  try {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      return res.status(400).send('SLACK_BOT_TOKEN environment variable not set');
    }
    
    // Fetch channels with member IDs
    const channels = await fetchChannelsWithMembers(token);
    
    // Transform to stored format
    const storedChannels: StoredChannel[] = channels.map((channel: any) => ({
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
    
    // Store channels
    await dbService.storeChannels(storedChannels);
    
    // Create memberships
    const memberships: ChannelMembership[] = [];
    for (const channel of channels) {
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
    
    // Store memberships
    await dbService.storeChannelMemberships(memberships);
    
    res.send(`Successfully refreshed ${storedChannels.length} channels and ${memberships.length} memberships`);
  } catch (error) {
    res.status(500).send(`Error refreshing channels: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

app.post('/refresh/users', async (req, res) => {
  try {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      return res.status(400).send('SLACK_BOT_TOKEN environment variable not set');
    }
    
    // Fetch all users
    const users = await fetchUsers(token);
    
    // Transform to stored format
    const storedUsers: StoredUser[] = users.map((user: any) => ({
      id: user.id,
      name: user.name || '',
      display_name: user.profile?.display_name || '',
      real_name: user.profile?.real_name || '',
      email: user.profile?.email || '',
      is_bot: user.is_bot || false,
      is_deleted: user.deleted || false,
      profile_image: user.profile?.image_72 || '',
      timezone: user.tz || '',
      updated_at: Date.now()
    }));
    
    // Store users
    await dbService.storeUsers(storedUsers);
    
    res.send(`Successfully refreshed ${storedUsers.length} users`);
  } catch (error) {
    res.status(500).send(`Error refreshing users: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// MCP endpoint using SDK transport
app.post('/mcp', async (req, res) => {
  console.log('MCP request received:', req.method, req.url);
  console.log('Headers:', req.headers);
  
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode for simplicity
    });
    
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    
    res.on('close', () => {
      server.close();
    });
  } catch (error) {
    console.error('MCP transport error:', error);
    res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal error' },
      id: null
    });
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