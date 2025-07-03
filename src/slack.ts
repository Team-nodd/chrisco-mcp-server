import { WebClient } from '@slack/web-api';

export function getSlackClient(token: string) {
  return new WebClient(token);
}

export async function sendMessage(
  token: string, 
  channel: string, 
  text: string, 
  options?: {
    thread_ts?: string;           // Reply to this message timestamp (for threading)
    reply_broadcast?: boolean;    // Make thread reply visible in channel
    attachments?: any[];          // File attachments
    blocks?: any[];              // Rich formatting blocks
    unfurl_links?: boolean;      // Auto-expand links
    unfurl_media?: boolean;      // Auto-expand media
  }
) {
  const slack = getSlackClient(token);
  
  const messageParams: any = {
    channel,
    text
  };
  
  // Add thread reply support
  if (options?.thread_ts) {
    messageParams.thread_ts = options.thread_ts;
    
    // If reply_broadcast is true, the threaded reply will also appear in the main channel
    if (options.reply_broadcast) {
      messageParams.reply_broadcast = true;
    }
  }
  
  // Add file attachments
  if (options?.attachments && options.attachments.length > 0) {
    messageParams.attachments = options.attachments;
  }
  
  // Add rich formatting blocks
  if (options?.blocks && options.blocks.length > 0) {
    messageParams.blocks = options.blocks;
  }
  
  // Link/media unfurling
  if (options?.unfurl_links !== undefined) {
    messageParams.unfurl_links = options.unfurl_links;
  }
  if (options?.unfurl_media !== undefined) {
    messageParams.unfurl_media = options.unfurl_media;
  }
  
  return slack.chat.postMessage(messageParams);
}

export async function fetchChannels(token: string) {
  const slack = getSlackClient(token);
  const result = await slack.conversations.list({
    exclude_archived: true,
    types: 'public_channel,private_channel,im,mpim',
    limit: 1000
  });

  const channels = (result.channels || []).filter((c: any) => {
    if (c.is_channel || c.is_group || c.is_mpim) {
      return c.is_member && !c.is_archived;
    }
    if (c.is_im) {
      return !c.is_archived && !c.is_user_deleted;
    }
    return false;
  });

  const enrichedChannels = await Promise.all(
    channels.map(async (c: any) => {
      let membersInfo: any[] = [];
      if ((c.is_channel || c.is_group || c.is_mpim)) {
        // Fetch member IDs for the channel
        let memberIds: string[] = [];
        try {
          const membersRes = await slack.conversations.members({ channel: c.id });
          memberIds = membersRes.members as string[];
        } catch {
          memberIds = [];
        }
        // Fetch user info for each member
        membersInfo = await Promise.all(
          memberIds.map(async (userId: string) => {
            try {
              const userInfo = await slack.users.info({ user: userId });
              return {
                id: userId,
                name: userInfo.user?.real_name || userInfo.user?.profile?.display_name || userInfo.user?.name || userId,
                is_deleted: userInfo.user?.deleted || false
              };
            } catch {
              return { id: userId, name: userId, is_deleted: true };
            }
          })
        );
      }

      if (c.is_im && c.user) {
        const userInfo = await slack.users.info({ user: c.user });
        return {
          id: c.id,
          name: userInfo.user?.real_name || userInfo.user?.profile?.display_name || userInfo.user?.name || c.user,
          type: 'im',
          is_user_deleted: userInfo.user?.deleted || false,
          created: c.created,
          is_active: !c.is_archived && !userInfo.user?.deleted,
          user_id: c.user
        };
      } else {
        return {
          id: c.id,
          name: c.name,
          type: c.is_channel ? 'channel' : c.is_group ? 'group' : c.is_mpim ? 'mpim' : 'other',
          is_ext_shared: !!c.is_ext_shared,
          is_private: !!c.is_private,
          is_archived: !!c.is_archived,
          is_member: !!c.is_member,
          num_members: c.num_members,
          topic: c.topic?.value || '',
          purpose: c.purpose?.value || '',
          created: c.created,
          creator: c.creator,
          members: membersInfo,
          is_active: !c.is_archived
        };
      }
    })
  );

  return enrichedChannels;
}

export async function fetchThreadReplies(token: string, channelId: string, threadTs: string, limit = 50) {
  const slack = getSlackClient(token);
  
  try {
    console.error(`Fetching thread replies for channel: ${channelId}, thread: ${threadTs}`);
    
    const replies = await slack.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: limit
    });
    
    if (replies.messages && replies.messages.length > 0) {
      // Get channel info to add context
      let channelInfo: any = {};
      try {
        const info = await slack.conversations.info({ channel: channelId });
        channelInfo = info.channel || {};
      } catch (error) {
        console.error('Could not fetch channel info:', error);
      }
      
      // Add channel and thread context to each message
      const messagesWithContext = replies.messages.map((msg: any) => ({
        ...msg,
        conversation_id: channelId,
        conversation_name: channelInfo.name || channelId,
        conversation_type: channelInfo.is_channel ? 'channel' : 
                         channelInfo.is_group ? 'group' : 
                         channelInfo.is_mpim ? 'mpim' : 
                         channelInfo.is_im ? 'im' : 'unknown',
        thread_ts: threadTs,
        is_thread_reply: msg.ts !== threadTs // Mark if this is a reply (not the parent message)
      }));
      
      console.error(`Returning ${messagesWithContext.length} messages from thread ${threadTs} in ${channelInfo.name || channelId}`);
      return messagesWithContext;
    }
    
    console.error('No messages found in thread');
    return [];
    
  } catch (error) {
    console.error(`Error fetching thread replies for ${channelId}/${threadTs}:`, error);
    throw error;
  }
}

export async function fetchLatestMessagesFromChannel(token: string, channelId: string) {
  const slack = getSlackClient(token);
  const SLACK_LIMIT = 15; // Hard-coded due to new Slack API limits for non-Marketplace apps
  
  try {
    console.error(`Fetching ${SLACK_LIMIT} most recent messages (including threads) for channel: ${channelId}`);
    
    // Get the most recent primary messages from the channel
    const history = await slack.conversations.history({
      channel: channelId,
      limit: SLACK_LIMIT
    });
    
    if (!history.messages || history.messages.length === 0) {
      console.error('No messages found in channel');
      return [];
    }
    
    console.error(`Found ${history.messages.length} primary messages to process`);
    
    // Get channel info to add context
    let channelInfo: any = {};
    try {
      const info = await slack.conversations.info({ channel: channelId });
      channelInfo = info.channel || {};
    } catch (error) {
      console.error('Could not fetch channel info:', error);
    }
    
    const messagesWithThreads: any[] = [];
    
    // Process each primary message and nest thread replies under parent
    for (const msg of history.messages) {
      // Add the primary message with context
      const messageWithContext = {
        ...msg,
        conversation_id: channelId,
        conversation_name: channelInfo.name || channelId,
        conversation_type: channelInfo.is_channel ? 'channel' : 
                         channelInfo.is_group ? 'group' : 
                         channelInfo.is_mpim ? 'mpim' : 
                         channelInfo.is_im ? 'im' : 'unknown',
        is_thread_parent: (msg.reply_count && msg.reply_count > 0) || false,
        is_thread_reply: false,
        thread_replies: [] as any[] // Initialize empty array for thread replies
      };
      
      // Check if this message has thread replies
      if (msg.reply_count && msg.reply_count > 0 && msg.ts) {
        try {
          console.error(`Message ${msg.ts} has ${msg.reply_count} thread replies - fetching all replies`);
          
          // Add a small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 100));
          
          // Fetch ALL thread replies for this message
          const replies = await slack.conversations.replies({
            channel: channelId,
            ts: msg.ts,
            limit: 1000 // Set high limit to get all replies in the thread
          });
          
          if (replies.messages && replies.messages.length > 1) {
            // Skip the first message (it's the parent) and nest the replies
            const threadReplies = replies.messages.slice(1).map((reply: any) => ({
              ...reply,
              conversation_id: channelId,
              conversation_name: channelInfo.name || channelId,
              conversation_type: messageWithContext.conversation_type,
              thread_ts: msg.ts,
              is_thread_parent: false,
              is_thread_reply: true,
              parent_message_ts: msg.ts
            }));
            
            messageWithContext.thread_replies = threadReplies;
            console.error(`Added ${threadReplies.length} thread replies under message ${msg.ts}`);
          }
        } catch (threadError) {
          console.error(`Error fetching thread replies for message ${msg.ts}:`, threadError);
          // Continue processing other messages even if one thread fails
        }
      }
      
      messagesWithThreads.push(messageWithContext);
    }
    
    // Sort messages chronologically by timestamp (oldest first, newest last)
    messagesWithThreads.sort((a, b) => {
      const aTs = parseFloat(a.ts || '0');
      const bTs = parseFloat(b.ts || '0');
      return aTs - bTs; // Chronological order (oldest first)
    });
    
    const totalThreadReplies = messagesWithThreads.reduce((sum, msg) => sum + (msg.thread_replies?.length || 0), 0);
    console.error(`Returning ${messagesWithThreads.length} primary messages with ${totalThreadReplies} nested thread replies from ${channelInfo.name || channelId}`);
    
    return messagesWithThreads;
    
  } catch (error) {
    console.error(`Error fetching messages for ${channelId}:`, error);
    throw error;
  }
}

// New function to fetch all users
export async function fetchUsers(token: string) {
  const web = new WebClient(token);
  
  try {
    const result = await web.users.list({
      limit: 1000 // Adjust as needed
    });
    
    if (!result.ok) {
      throw new Error(`Slack API error: ${result.error}`);
    }
    
    return result.members || [];
  } catch (error) {
    console.error('Error fetching users:', error);
    throw error;
  }
}

// New function to fetch user info by ID
export async function fetchUserInfo(token: string, userId: string) {
  const web = new WebClient(token);
  
  try {
    const result = await web.users.info({
      user: userId
    });
    
    if (!result.ok) {
      throw new Error(`Slack API error: ${result.error}`);
    }
    
    return result.user;
  } catch (error) {
    console.error(`Error fetching user info for ${userId}:`, error);
    throw error;
  }
}

// Enhanced function to fetch channels with member details
export async function fetchChannelsWithMembers(token: string) {
  const web = new WebClient(token);
  
  try {
    // Get all channels
    const channelsResult = await web.conversations.list({
      types: 'public_channel,private_channel',
      limit: 1000
    });
    
    if (!channelsResult.ok) {
      throw new Error(`Slack API error: ${channelsResult.error}`);
    }
    
    const channels = channelsResult.channels || [];
    const channelsWithMembers = [];
    
    // For each channel, get its members
    for (const channel of channels) {
      try {
        const membersResult = await web.conversations.members({
          channel: channel.id
        });
        
        if (membersResult.ok) {
          channelsWithMembers.push({
            ...channel,
            member_ids: membersResult.members || []
          });
        } else {
          // If we can't get members (e.g., private channel), still include the channel
          channelsWithMembers.push({
            ...channel,
            member_ids: []
          });
        }
      } catch (memberError) {
        console.warn(`Could not fetch members for channel ${channel.id}:`, memberError);
        channelsWithMembers.push({
          ...channel,
          member_ids: []
        });
      }
    }
    
    return channelsWithMembers;
  } catch (error) {
    console.error('Error fetching channels with members:', error);
    throw error;
  }
} 