# Slack MCP Server

Enterprise-grade Model Context Protocol (MCP) server for Slack integration with advanced business features.

**✅ Connected to Railway auto-deploy!**

## Overview

This MCP server provides comprehensive Slack workspace integration through Claude.ai, enabling:
- **Channel Management**: List and explore accessible Slack channels
- **Message Retrieval**: Fetch latest messages with threaded replies
- **Thread Navigation**: Get complete conversation threads
- **Message Sending**: Send messages with threading and formatting options
- **Rich Resources**: Access Slack API documentation and best practices
- **Workflow Prompts**: Generate team communication templates

## Features

### 🛠️ Tools (4 available)
- `get_slack_channels` - List all accessible channels with member information
- `get_channel_messages` - Retrieve latest 15 messages with nested thread replies
- `get_thread_replies` - Get all replies to a specific message thread
- `send_slack_message` - Send messages with advanced threading and formatting

### 📚 Resources (3 available)
- `slack://api-documentation` - Comprehensive Slack API integration guide
- `slack://rate-limits` - Current API rate limiting information
- `slack://message-formatting` - Message formatting and Block Kit guide

### 💬 Prompts (3 available)
- `slack_team_standup` - Generate team standup templates
- `slack_incident_response` - Create incident response communication
- `slack_project_kickoff` - Project kickoff communication templates

## Quick Start

### 1. Installation
```bash
cd slack-mcp-server
npm install
```

### 2. Build
```bash
npm run build
```

### 3. Development
```bash
npm run dev
```

### 4. Production
```bash
npm start
```

## Deployment

### Railway (Recommended)
This server is configured for Railway deployment with automatic builds and health checks.

1. **Connect to Railway**:
   ```bash
   npm install -g @railway/cli
   railway login
   railway init --name slack-mcp-server
   ```

2. **Deploy**:
   ```bash
   git add .
   git commit -m "Deploy slack-mcp-server"
   git push origin main
   ```

3. **Your MCP endpoint will be**:
   ```
   https://your-project.up.railway.app/sse
   ```

### Alternative Hosting
- **Render**: Native Node.js support with free tier
- **DigitalOcean App Platform**: $5/month, reliable hosting
- **Fly.io**: Global distribution with generous free tier
- **Heroku**: Mature platform, $7/month

## Slack Bot Setup

### 1. Create Slack App
1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click "Create New App" → "From scratch"
3. Name your app and select workspace

### 2. Configure Bot Permissions
Add these OAuth scopes under "OAuth & Permissions":
- `channels:read` - Read public channel information
- `groups:read` - Read private channel information
- `im:read` - Read direct messages
- `chat:write` - Send messages
- `users:read` - Read user information

### 3. Install to Workspace
1. Click "Install to Workspace"
2. Copy the "Bot User OAuth Token" (starts with `xoxb-`)

### 4. Get Channel IDs
- Right-click any channel → "View channel details" → Copy Channel ID
- Or use the `get_slack_channels` tool to list all accessible channels

## Claude.ai Integration

### 1. Add MCP Server
In Claude.ai, go to Settings → MCP Servers and add:
```json
{
  "name": "slack-mcp-server", 
  "endpoint": "https://your-railway-app.up.railway.app/sse",
  "transport": "streamableHttp"
}
```

### 2. Test Connection
Ask Claude: "What Slack tools are available?"

You should see all 4 tools, 3 resources, and 3 prompts listed.

## Usage Examples

### Get Channel List
```
Use the get_slack_channels tool with token: xoxb-your-token
```

### Read Messages
```
Get latest messages from channel C1234567890 using token: xoxb-your-token
```

### Send Message
```
Send "Hello team!" to channel C1234567890 using token: xoxb-your-token
```

### Thread Reply
```
Reply to message 1234567890.123456 in channel C1234567890 with: "Great point!"
```

## API Limitations

⚠️ **Important**: Non-Marketplace Slack apps have severe API restrictions as of May 2025:

- **conversations.history**: 1 request/minute, max 15 messages
- **Rate limits**: Tier 4 restrictions apply
- **Workaround**: Use webhooks for real-time updates instead of polling

## Architecture

```
Claude.ai ←→ MCP Protocol ←→ Slack MCP Server ←→ Slack Web API
```

- **Transport**: StreamableHTTP (modern MCP protocol)
- **Framework**: Express.js with CORS support
- **Slack SDK**: @slack/web-api v7.0
- **Validation**: Zod schemas for input validation
- **Deployment**: Railway with health checks

## Development

### Project Structure
```
slack-mcp-server/
├── src/
│   ├── index.ts      # Main MCP server
│   └── slack.ts      # Slack API functions
├── build/            # Compiled output
├── package.json      # Dependencies
├── tsconfig.json     # TypeScript config
├── railway.json      # Railway deployment
└── README.md         # This file
```

### Scripts
- `npm run build` - Compile TypeScript
- `npm run dev` - Development with auto-rebuild
- `npm start` - Production server
- `npm run clean` - Remove build files

### Environment
- **Node.js**: >=18.0.0
- **TypeScript**: ^5.0.0
- **MCP SDK**: ^1.0.0

## Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feature-name`
3. Make changes and test thoroughly
4. Submit pull request with detailed description

## License

MIT License - see LICENSE file for details.

## Support

- **Issues**: Report bugs and feature requests via GitHub Issues
- **Documentation**: Slack API docs at [api.slack.com](https://api.slack.com)
- **MCP Protocol**: [Model Context Protocol Specification](https://spec.modelcontextprotocol.io)

---

**Built with ❤️ for enterprise Slack integration** 