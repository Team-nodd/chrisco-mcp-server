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
export async function fetchChannelsWithMembers(token: string, includeFullMemberDetails = false) {
  const web = new WebClient(token);
  
  try {
    // Get all conversation types including DMs
    const channelsResult = await web.conversations.list({
      types: 'public_channel,private_channel,im,mpim',
      limit: 1000
    });
    
    if (!channelsResult.ok) {
      throw new Error(`Slack API error: ${channelsResult.error}`);
    }
    
    const allConversations = channelsResult.channels || [];
    const conversationsWithMembers = [];
    
    // For each conversation, get its members (different handling for DMs vs channels)
    for (const conversation of allConversations) {
      try {
        if (conversation.is_im) {
          // For DMs, we don't need to fetch members - it's just the other user
          let memberDetails = undefined;
          
          // If full details requested, get user info for DM partner
          if (includeFullMemberDetails && conversation.user) {
            try {
              const userInfo = await web.users.info({ user: conversation.user });
              memberDetails = [{
                id: conversation.user,
                name: userInfo.user?.name || '',
                display_name: userInfo.user?.profile?.display_name || '',
                real_name: userInfo.user?.real_name || '',
                email: userInfo.user?.profile?.email || '',
                is_bot: userInfo.user?.is_bot || false,
                is_deleted: userInfo.user?.deleted || false,
                is_restricted: userInfo.user?.is_restricted || false,
                is_ultra_restricted: userInfo.user?.is_ultra_restricted || false,
                is_app_user: userInfo.user?.is_app_user || false,
                is_admin: userInfo.user?.is_admin || false,
                is_owner: userInfo.user?.is_owner || false,
                profile_image: userInfo.user?.profile?.image_72 || '',
                timezone: userInfo.user?.tz || '',
                locale: userInfo.user?.locale || '',
                team_id: userInfo.user?.team_id || '',
                updated_at: Date.now()
              }];
            } catch (error) {
              console.warn(`Could not fetch user details for ${conversation.user}:`, error);
              memberDetails = [{ id: conversation.user, name: conversation.user, is_deleted: false }];
            }
          }
          
          conversationsWithMembers.push({
            ...conversation,
            member_ids: conversation.user ? [conversation.user] : [],
            member_details: memberDetails,
            type: 'im'
          });
        } else if (conversation.is_mpim) {
          // For multi-person DMs, get the member list
          const membersResult = await web.conversations.members({
            channel: conversation.id
          });
          
          const memberIds = membersResult.ok ? (membersResult.members || []) : [];
          let memberDetails = undefined;
          
          // If full details requested, get user info for each member
          if (includeFullMemberDetails && memberIds.length > 0) {
            memberDetails = await Promise.all(
              memberIds.map(async (userId: string) => {
                try {
                  const userInfo = await web.users.info({ user: userId });
                  return {
                    id: userId,
                    name: userInfo.user?.name || '',
                    display_name: userInfo.user?.profile?.display_name || '',
                    real_name: userInfo.user?.real_name || '',
                    email: userInfo.user?.profile?.email || '',
                    is_bot: userInfo.user?.is_bot || false,
                    is_deleted: userInfo.user?.deleted || false,
                    is_restricted: userInfo.user?.is_restricted || false,
                    is_ultra_restricted: userInfo.user?.is_ultra_restricted || false,
                    is_app_user: userInfo.user?.is_app_user || false,
                    is_admin: userInfo.user?.is_admin || false,
                    is_owner: userInfo.user?.is_owner || false,
                    profile_image: userInfo.user?.profile?.image_72 || '',
                    timezone: userInfo.user?.tz || '',
                    locale: userInfo.user?.locale || '',
                    team_id: userInfo.user?.team_id || '',
                    updated_at: Date.now()
                  };
                } catch (error) {
                  console.warn(`Could not fetch user details for ${userId}:`, error);
                  return { id: userId, name: userId, is_deleted: false };
                }
              })
            );
          }
          
          conversationsWithMembers.push({
            ...conversation,
            member_ids: memberIds,
            member_details: memberDetails,
            type: 'mpim'
          });
        } else {
          // For regular channels (public/private), get the member list
          const membersResult = await web.conversations.members({
            channel: conversation.id
          });
          
          const memberIds = membersResult.ok ? (membersResult.members || []) : [];
          let memberDetails = undefined;
          
          // If full details requested, get user info for each member
          if (includeFullMemberDetails && memberIds.length > 0) {
            memberDetails = await Promise.all(
              memberIds.map(async (userId: string) => {
                try {
                  const userInfo = await web.users.info({ user: userId });
                  return {
                    id: userId,
                    name: userInfo.user?.name || '',
                    display_name: userInfo.user?.profile?.display_name || '',
                    real_name: userInfo.user?.real_name || '',
                    email: userInfo.user?.profile?.email || '',
                    is_bot: userInfo.user?.is_bot || false,
                    is_deleted: userInfo.user?.deleted || false,
                    is_restricted: userInfo.user?.is_restricted || false,
                    is_ultra_restricted: userInfo.user?.is_ultra_restricted || false,
                    is_app_user: userInfo.user?.is_app_user || false,
                    is_admin: userInfo.user?.is_admin || false,
                    is_owner: userInfo.user?.is_owner || false,
                    profile_image: userInfo.user?.profile?.image_72 || '',
                    timezone: userInfo.user?.tz || '',
                    locale: userInfo.user?.locale || '',
                    team_id: userInfo.user?.team_id || '',
                    updated_at: Date.now()
                  };
                } catch (error) {
                  console.warn(`Could not fetch user details for ${userId}:`, error);
                  return { id: userId, name: userId, is_deleted: false };
                }
              })
            );
          }
          
          conversationsWithMembers.push({
            ...conversation,
            member_ids: memberIds,
            member_details: memberDetails,
            type: conversation.is_private ? 'private_channel' : 'public_channel'
          });
        }
      } catch (memberError) {
        console.warn(`Could not fetch members for conversation ${conversation.id}:`, memberError);
        conversationsWithMembers.push({
          ...conversation,
          member_ids: [],
          member_details: includeFullMemberDetails ? [] : undefined,
          type: conversation.is_im ? 'im' : conversation.is_mpim ? 'mpim' : 
                conversation.is_private ? 'private_channel' : 'public_channel'
        });
      }
    }
    
    const memberDetailMessage = includeFullMemberDetails ? " with full member details" : " with member IDs only";
    console.log(`Fetched ${conversationsWithMembers.length} conversations${memberDetailMessage} including:
      - Channels: ${conversationsWithMembers.filter(c => c.type.includes('channel')).length}
      - DMs: ${conversationsWithMembers.filter(c => c.type === 'im').length}  
      - Group DMs: ${conversationsWithMembers.filter(c => c.type === 'mpim').length}`);
    
    return conversationsWithMembers;
  } catch (error) {
    console.error('Error fetching conversations with members:', error);
    throw error;
  }
}

// Unified function to refresh all Slack data (channels, users, and memberships) in one operation
export async function refreshAllSlackData(token: string) {
  try {
    // Fetch all conversations with full member details
    const conversations = await fetchChannelsWithMembers(token, true);
    
    // Extract all unique users from all conversations
    const allUsers = new Map(); // Use Map to deduplicate by user ID
    
    for (const conversation of conversations) {
      if (conversation.member_details) {
        for (const user of conversation.member_details) {
          allUsers.set(user.id, user);
        }
      }
    }
    
    // Convert Map to array
    const uniqueUsers = Array.from(allUsers.values());
    
    console.log(`Unified refresh collected:
      - ${conversations.length} conversations (channels/DMs)
      - ${uniqueUsers.length} unique users
      - ${conversations.reduce((sum, c) => sum + (c.member_ids?.length || 0), 0)} total memberships`);
    
    return {
      conversations,
      users: uniqueUsers,
      totalMemberships: conversations.reduce((sum, c) => sum + (c.member_ids?.length || 0), 0)
    };
  } catch (error) {
    console.error('Error in unified Slack data refresh:', error);
    throw error;
  }
}

 