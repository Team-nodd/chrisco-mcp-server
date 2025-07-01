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
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';
import { fetchChannels, fetchLatestMessagesFromChannel, fetchThreadReplies, sendMessage } from './slack.js';

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
        description: 'Get list of Slack channels with rich information including members',
        inputSchema: {
          type: 'object',
          properties: {
            token: {
              type: 'string',
              description: 'Slack Bot Token (xoxb-...)'
            }
          },
          required: ['token']
        }
      },
      {
        name: 'get_channel_messages',
        description: 'Get latest messages from a Slack channel with nested thread replies (limited to 15 due to API restrictions)',
        inputSchema: {
          type: 'object',
          properties: {
            token: {
              type: 'string',
              description: 'Slack Bot Token (xoxb-...)'
            },
            channel: {
              type: 'string',
              description: 'Channel ID (e.g., C1234567890)'
            }
          },
          required: ['token', 'channel']
        }
      },
      {
        name: 'get_thread_replies',
        description: 'Get all replies to a specific message thread in a Slack channel',
        inputSchema: {
          type: 'object',
          properties: {
            token: {
              type: 'string',
              description: 'Slack Bot Token (xoxb-...)'
            },
            channel: {
              type: 'string',
              description: 'Channel ID (e.g., C1234567890)'
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
          required: ['token', 'channel', 'thread_ts']
        }
      },
      {
        name: 'send_slack_message',
        description: 'Send a message to a Slack channel with advanced options for threading and formatting',
        inputSchema: {
          type: 'object',
          properties: {
            token: {
              type: 'string',
              description: 'Slack Bot Token (xoxb-...)'
            },
            channel: {
              type: 'string',
              description: 'Channel ID (e.g., C1234567890)'
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
          required: ['token', 'channel', 'text']
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  console.log('Tools/call request:', request.params);
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'get_slack_channels':
      try {
        const channels = await fetchChannels((args as any).token);

        if (!channels || channels.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No channels found or unable to access channels with the provided token'
              }
            ]
          };
        }

        const formattedChannels = channels.map((channel: any) => {
          const details = [
            `${channel.type === 'im' ? '@' : '#'}${channel.name} (${channel.id})`,
            channel.type === 'im' ? 'Direct Message' : (channel.is_private ? "Private" : "Public"),
            channel.is_archived ? "Archived" : "Active",
            channel.num_members ? `${channel.num_members} members` : "",
            channel.topic ? `Topic: ${channel.topic}` : "",
            channel.purpose ? `Purpose: ${channel.purpose}` : ""
          ].filter(Boolean).join(" | ");
          
          let membersList = "";
          if (channel.members && channel.members.length > 0) {
            const activeMembers = channel.members.filter((m: any) => !m.is_deleted);
            if (activeMembers.length > 0) {
              membersList = `\n  Members: ${activeMembers.map((m: any) => m.name).join(", ")}`;
            }
          }
          
          return details + membersList;
        });

        const channelsText = `Found ${channels.length} accessible channels:\n\n${formattedChannels.join("\n\n")}`;

        return {
          content: [
            {
              type: 'text',
              text: channelsText
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to retrieve channels: ${error instanceof Error ? error.message : "Unknown error"}`
            }
          ]
        };
      }

    case 'get_channel_messages':
      try {
        const messages = await fetchLatestMessagesFromChannel((args as any).token, (args as any).channel);

        if (!messages || messages.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No messages found in channel ${(args as any).channel}`
              }
            ]
          };
        }

        const formattedMessages = messages.map((msg: any) => {
          const timestamp = new Date(parseFloat(msg.ts) * 1000).toLocaleString();
          const threadInfo = msg.is_thread_parent ? ` (${msg.thread_replies?.length || 0} replies)` : "";
          
          let messageText = [
            `[${timestamp}] User: ${msg.user || "Unknown"}${threadInfo}`,
            `Message: ${msg.text}`,
            msg.reactions?.length ? `Reactions: ${msg.reactions.map((r: any) => `${r.name} (${r.count})`).join(", ")}` : ""
          ].filter(Boolean).join("\n");
          
          // Add nested thread replies
          if (msg.thread_replies && msg.thread_replies.length > 0) {
            const replies = msg.thread_replies.map((reply: any) => {
              const replyTimestamp = new Date(parseFloat(reply.ts) * 1000).toLocaleString();
              return [
                `  ↳ [${replyTimestamp}] ${reply.user || "Unknown"}:`,
                `    ${reply.text}`,
                reply.reactions?.length ? `    Reactions: ${reply.reactions.map((r: any) => `${r.name} (${r.count})`).join(", ")}` : ""
              ].filter(Boolean).join("\n");
            });
            messageText += "\n" + replies.join("\n");
          }
          
          return messageText + "\n---";
        });

        const totalThreadReplies = messages.reduce((sum: number, msg: any) => sum + (msg.thread_replies?.length || 0), 0);
        const messagesText = `Latest ${messages.length} messages from channel ${(args as any).channel} with ${totalThreadReplies} thread replies:\n\n${formattedMessages.join("\n")}`;

        return {
          content: [
            {
              type: 'text',
              text: messagesText
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to retrieve messages from channel ${(args as any).channel}: ${error instanceof Error ? error.message : "Unknown error"}`
            }
          ]
        };
      }

    case 'get_thread_replies':
      try {
        const messages = await fetchThreadReplies((args as any).token, (args as any).channel, (args as any).thread_ts, (args as any).limit || 50);

        if (!messages || messages.length <= 1) {
          return {
            content: [
              {
                type: 'text',
                text: `No replies found for thread ${(args as any).thread_ts} in channel ${(args as any).channel}`
              }
            ]
          };
        }

        // Skip the first message (parent) and format replies
        const replies = messages.slice(1);
        
        const formattedReplies = replies.map((msg: any) => {
          const timestamp = new Date(parseFloat(msg.ts) * 1000).toLocaleString();
          
          return [
            `[${timestamp}] User: ${msg.user || "Unknown"}`,
            `Reply: ${msg.text}`,
            msg.reactions?.length ? `Reactions: ${msg.reactions.map((r: any) => `${r.name} (${r.count})`).join(", ")}` : "",
            "---"
          ].filter(Boolean).join("\n");
        });

        const parentMsg = messages[0];
        const parentTimestamp = new Date(parseFloat(parentMsg.ts) * 1000).toLocaleString();
        
        const threadText = [
          `Thread for message ${(args as any).thread_ts} in #${parentMsg.conversation_name}:`,
          "",
          `Original message [${parentTimestamp}] by ${parentMsg.user || "Unknown"}:`,
          parentMsg.text,
          "",
          `${replies.length} replies:`,
          "",
          formattedReplies.join("\n")
        ].join("\n");

        return {
          content: [
            {
              type: 'text',
              text: threadText
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to retrieve thread replies: ${error instanceof Error ? error.message : "Unknown error"}`
            }
          ]
        };
      }

    case 'send_slack_message':
      try {
        const options: any = {};
        
        if ((args as any).thread_ts) {
          options.thread_ts = (args as any).thread_ts;
          if ((args as any).reply_broadcast) {
            options.reply_broadcast = true;
          }
        }
        
        if ((args as any).unfurl_links !== undefined) {
          options.unfurl_links = (args as any).unfurl_links;
        }
        
        if ((args as any).unfurl_media !== undefined) {
          options.unfurl_media = (args as any).unfurl_media;
        }

        const result = await sendMessage((args as any).token, (args as any).channel, (args as any).text, options);
        
        const timestamp = new Date(parseFloat(result.ts || '0') * 1000).toLocaleString();
        const threadInfo = (args as any).thread_ts ? " (as thread reply)" : "";
        const broadcastInfo = (args as any).thread_ts && (args as any).reply_broadcast ? " (broadcasted to channel)" : "";
        
        return {
          content: [
            {
              type: 'text',
              text: `Message sent successfully${threadInfo}${broadcastInfo}!\n\nChannel: ${(args as any).channel}\nTimestamp: ${result.ts} (${timestamp})\nMessage: ${(args as any).text}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to send message: ${error instanceof Error ? error.message : "Unknown error"}`
            }
          ]
        };
      }

    default:
      throw new Error(`Unknown tool: ${name}`);
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
  res.json({
    name: 'Slack MCP Server',
    version: '1.0.0',
    description: 'Enterprise-grade MCP server for Slack integration',
    endpoints: {
      health: '/health',
      sse: '/sse'
    },
    capabilities: ['tools', 'resources', 'prompts'],
    tools: ['get_slack_channels', 'get_channel_messages', 'get_thread_replies', 'send_slack_message'],
    resources: ['slack://api-documentation', 'slack://rate-limits', 'slack://message-formatting'],
    prompts: ['slack_team_standup', 'slack_incident_response', 'slack_project_kickoff']
  });
});

// MCP SSE endpoint
app.use('/sse', (req, res, next) => {
  console.log('MCP SSE request received:', req.method, req.url);
  console.log('Headers:', req.headers);
  
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });
  transport.handleRequest(req, res, req.body);
});

async function main() {
  await server.connect(new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  }));
  
  app.listen(PORT, () => {
    console.log(`🚀 Slack MCP Server running on port ${PORT}`);
    console.log(`📡 MCP endpoint: http://localhost:${PORT}/sse`);
    console.log(`❤️ Health check: http://localhost:${PORT}/health`);
    console.log(`🏠 Homepage: http://localhost:${PORT}/`);
  });
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
}); 