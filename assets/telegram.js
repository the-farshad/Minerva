/* Minerva — Telegram Bot API wrapper.
 *
 * api.telegram.org allows direct browser CORS calls, so this is purely
 * client-side. Three primitives:
 *
 *   Minerva.telegram.getMe(token)            → { id, username, first_name, ... }
 *   Minerva.telegram.sendMessage(token, chatId, text, opts)
 *   Minerva.telegram.getUpdates(token, offset)
 *   Minerva.telegram.detectChatId(token)     → the most recent chat that
 *                                              messaged the bot (helper for
 *                                              setup; user sends "/start" to
 *                                              their bot, Minerva picks up
 *                                              the chat ID)
 *
 * Reminders run client-side only — see app.js Telegram panel for the tick
 * loop. For always-on reminders (i.e. without keeping a Minerva tab open),
 * the user installs an Apps Script template documented in
 * docs/setup-telegram.md.
 */
(function () {
  'use strict';

  var BASE = 'https://api.telegram.org/bot';

  async function api(token, method, body) {
    if (!token) throw new Error('Telegram bot token missing.');
    var resp = await fetch(BASE + token + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    var data;
    try { data = await resp.json(); }
    catch (e) { throw new Error('Telegram returned non-JSON (' + resp.status + ').'); }
    if (!data.ok) throw new Error(data.description || ('Telegram error ' + resp.status));
    return data.result;
  }

  function getMe(token) {
    return api(token, 'getMe', {});
  }

  function sendMessage(token, chatId, text, opts) {
    var body = Object.assign({
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    }, opts || {});
    return api(token, 'sendMessage', body);
  }

  function getUpdates(token, offset) {
    return api(token, 'getUpdates', { offset: offset || 0, timeout: 0, limit: 50 });
  }

  // Helper for setup: pick the most recent chat that messaged the bot.
  // If the bot has a webhook configured, getUpdates returns 409 — let the
  // caller surface that to the user.
  async function detectChatId(token) {
    var updates = await getUpdates(token, 0);
    if (!updates || !updates.length) return null;
    for (var i = updates.length - 1; i >= 0; i--) {
      var u = updates[i];
      var chat = (u.message && u.message.chat) || (u.edited_message && u.edited_message.chat) || (u.channel_post && u.channel_post.chat);
      if (chat && chat.id != null) return String(chat.id);
    }
    return null;
  }

  window.Minerva = window.Minerva || {};
  window.Minerva.telegram = {
    getMe: getMe,
    sendMessage: sendMessage,
    getUpdates: getUpdates,
    detectChatId: detectChatId
  };
})();
