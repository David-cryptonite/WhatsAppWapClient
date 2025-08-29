

async function loadChatHistory(jid, batchSize = 999999999999999999999999999) {
  if (!sock) {
    logger.warn('Cannot load chat history: socket not available')
    return []
  }

  try {
    logger.info(`Loading FULL chat history for ${jid}`)

    const formattedJid = formatJid(jid)
    let cursor = undefined
    let keepFetching = true
    let allMessages = []

    while (keepFetching) {
      const batch = await sock.loadMessages(formattedJid, batchSize, cursor)
      if (!batch || batch.length === 0) break

      for (const msg of batch) {
        if (!msg.key?.id) continue
        saveMessageToDB(msg, formattedJid)
        allMessages.push(msg)
      }

      cursor = batch[0].key
      await delay(300)
    }

    logger.info(`Finished saving history for ${jid}, total: ${allMessages.length}`)
    return allMessages
  } catch (err) {
    logger.error(`Failed to load chat history for ${jid}:`, err.message)
    return []
  }
}




// =================== FUNZIONI DI SUPPORTO ===================

async function loadAllChatsHistory(maxChatsToLoad = 999999999, messagesPerChat = 99999999) {
  if (!sock || connectionState !== 'open') {
    logger.warn('Cannot load all chats history: not connected')
    return false
  }

  try {
    logger.info(`Starting bulk chat history load: ${maxChatsToLoad} chats, ${messagesPerChat} messages each`)
    
    const chatIds = Array.from(chatStore.keys()).slice(0, maxChatsToLoad)
    let successCount = 0
    let failCount = 0

    for (const chatId of chatIds) {
      try {
        const messages = await loadChatHistory(chatId, messagesPerChat)
        if (messages.length > 0) {
          successCount++
          logger.debug(`Loaded ${messages.length} messages for ${chatId}`)
        }
        
        // Delay per evitare rate limiting
        await delay(1000)
        
      } catch (chatError) {
        failCount++
        logger.error(`Failed to load history for ${chatId}:`, chatError.message)
      }
    }

    logger.info(`Bulk history load complete: ${successCount} success, ${failCount} failed`)
    return successCount > 0

  } catch (error) {
    logger.error('Bulk chat history load failed:', error.message)
    return false
  }
}

async function loadRecentMessages(jid, hours = 24) {
  const cutoffTime = Math.floor((Date.now() - (hours * 60 * 60 * 1000)) / 1000)
  
  try {
    const messages = await loadChatHistory(jid, 9999999999)
  
    
    logger.info(`Found ${recentMessages.length} recent messages (last ${hours}h) for ${jid}`)
    return messages
    
  } catch (error) {
    logger.error(`Failed to load recent messages for ${jid}:`, error.message)
    return []
  }
}

async function preloadImportantChats() {
  if (!sock) return

  try {
    logger.info('Preloading important chats...')
    
    // Identifica chat importanti (con molti messaggi o attività recente)
    const importantChats = Array.from(chatStore.entries())
      .map(([jid, messages]) => ({
        jid,
        messageCount: messages.length,
        lastActivity: messages.length > 0 ? 
          Math.max(...messages.map(m => Number(m.messageTimestamp))) : 0
      }))
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .slice(0, 10) // Top 10 chat più attive

    for (const chat of importantChats) {
      try {
        await loadChatHistory(chat.jid, 9999999999999999999)
        await delay(2000) // Delay maggiore per chat importanti
      } catch (error) {
        logger.warn(`Failed to preload important chat ${chat.jid}:`, error.message)
      }
    }
    
    logger.info(`Preloaded ${importantChats.length} important chats`)
    
  } catch (error) {
    logger.error('Important chats preload failed:', error.message)
  }
}

// Integrazione nel sistema esistente
async function enhancedInitialSync() {
  try {
    logger.info('Starting enhanced sync with message history loading...')
    
    // Prima esegui la sync base
    await performInitialSync()
    
    // Poi carica la cronologia dei messaggi
    if (chatStore.size > 0) {
      logger.info('Loading chat histories...')
      
      // Carica cronologia per le prime 20 chat
      await loadAllChatsHistory(5000, 5000)
      
      // Precarica chat importanti
      await preloadImportantChats()
      
      logger.info('Enhanced sync completed successfully')
    }
    
  } catch (error) {
    logger.error('Enhanced sync failed:', error.message)
  }
}

// Esporta le funzioni
module.exports = {
  loadChatHistory,
  loadAllChatsHistory,
  loadRecentMessages,
  preloadImportantChats,
  enhancedInitialSync
}