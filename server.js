const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const UPSTASH_URL = process.env.UPSTASH_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_TOKEN;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'botpme2026';

// ─── Redis helpers ─────────────────────────────────────────────
function sanitizeKey(key) {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function redisGet(key) {
  try {
    const res = await axios.post(
      UPSTASH_URL,
      ["GET", sanitizeKey(key)],
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    const result = res.data.result;
    if (!result) return null;
    return JSON.parse(Buffer.from(result, 'base64').toString('utf8'));
  } catch (e) {
    console.error('redisGet error:', e.message);
    return null;
  }
}

async function redisSet(key, value) {
  try {
    const encoded = Buffer.from(JSON.stringify(value)).toString('base64');
    await axios.post(
      UPSTASH_URL,
      ["SET", sanitizeKey(key), encoded],
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('redisSet error:', e.message);
  }
}

async function sendWhatsApp(instance, token, to, body) {
  await axios.post(
    `https://api.ultramsg.com/${instance}/messages/chat`,
    { token, to, body }
  );
}

// ─── Middleware admin ──────────────────────────────────────────
function adminAuth(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.body?.adminSecret;
  if (secret !== ADMIN_SECRET) return res.status(401).json({ error: 'Non autorisé' });
  next();
}

// ─── Page d'accueil ────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`
    <h2>🤖 BOTPME AFRIQUE — Multi-clients</h2>
    <p>Serveur actif ✅</p>
    <p>Webhook par client : /webhook/:clientId</p>
    <p>Dashboard : /leads/all</p>
  `);
});

// ─── Webhook par client ────────────────────────────────────────
app.post('/webhook/:clientId', async (req, res) => {
  res.sendStatus(200);

  try {
    const { clientId } = req.params;
    const data = req.body;

    if (!data.data || data.data.type !== 'chat' || data.data.fromMe === true) return;

    // Charger la config du client
    const config = await redisGet(`config_${clientId}`);
    if (!config) {
      console.log(`[WEBHOOK] Client inconnu : ${clientId}`);
      return;
    }

    const userMessage = data.data.body;
    const from = data.data.from;
    const msgLower = userMessage.toLowerCase().trim();
    const now = Date.now();
    const VINGT_QUATRE_H = 24 * 60 * 60 * 1000;

    // Session par client + numéro
    const sessionKey = `session_${clientId}_${from}`;
    let session = await redisGet(sessionKey) || {};
    let history = session.history || [];
    const lastActive = session.lastActive || 0;

    if (history.length > 0 && (now - lastActive) > VINGT_QUATRE_H) {
      history = [];
      session.langue = null;
    }

    let langue = session.langue || null;
    if (!langue) {
      const patternEn = /\b(hello|hi|hey|good|morning|evening|help|yes|no|want|need|price|how|what|my|i am|i'm|please|thanks|thank you|okay|ok|sure|great|perfect|nice)\b/i;
      langue = patternEn.test(userMessage) ? 'en' : 'fr';
      console.log(`[${clientId}] Langue détectée : ${langue}`);
    }

    history.push({ role: 'user', content: userMessage });
    if (history.length > 20) history = history.slice(-20);

    const businessName = config.businessName || 'notre agence';
    const systemPrompt = langue === 'en'
      ? `You are a WhatsApp assistant for "${businessName}", a business automation agency in Africa.

STRICT RULES:
- ALWAYS respond in English, maximum 3 lines
- NEVER repeat the welcome message if conversation already started
- Continue exactly where you left off
- Never ask the same question twice

SALES SCRIPT:
1. First message → Welcome and ask business sector (pharmacy, clinic, restaurant, shop, other)
2. After sector → "How many messages per day? A) Less than 20  B) 20-100  C) More than 100"
3. After A/B/C → Recommend using EXACT names:
   A = STARTER 50,000 FCFA/month
   B = PRO 100,000 FCFA/month
   C = PREMIUM 200,000 FCFA/month
4. → "7-day FREE trial? Reply YES"
5. After YES → "A consultant contacts you in 30 minutes. Thank you!"

Use EXACT names: STARTER, PRO, PREMIUM. Do not start over.`

      : `Tu es l'assistant WhatsApp de "${businessName}", une agence d'automatisation en Afrique.

RÈGLES ABSOLUES :
- Réponds TOUJOURS en français, maximum 3 lignes
- Ne répète JAMAIS le message de bienvenue si conversation déjà commencée
- Continue exactement là où tu en es
- Ne pose jamais deux fois la même question

SCRIPT DANS L'ORDRE :
1. Premier message → Saluer UNE FOIS et demander secteur : pharmacie, clinique, restaurant, boutique ou autre ?
2. Après secteur → "Combien de messages/jour ? A) Moins de 20  B) Entre 20 et 100  C) Plus de 100"
3. Après A/B/C → Recommander avec ces noms EXACTS :
   A = STARTER 50 000 FCFA/mois
   B = PRO 100 000 FCFA/mois
   C = PREMIUM 200 000 FCFA/mois
4. → "7 jours d'essai GRATUIT ? Répondez OUI"
5. Après OUI → "Un conseiller vous contacte dans 30 min. Merci !"

Noms EXACTS : STARTER, PRO, PREMIUM. Ne recommence pas depuis le début.`;

    const groqResponse = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'system', content: systemPrompt }, ...history],
        max_tokens: 300
      },
      { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
    );

    const reply = groqResponse.data.choices[0].message.content;
    history.push({ role: 'assistant', content: reply });

    await redisSet(sessionKey, { history, lastActive: now, langue });
    await sendWhatsApp(config.instance, config.token, from, reply);

    const clientDitOui = ['oui','yes'].some(w => msgLower.includes(w));

    if (clientDitOui) {
      const clientNum = from.replace('@c.us', '');

      const userMessages = history.filter(h => h.role === 'user').map(h => h.content).join(' ').toLowerCase();
      const assistantMessages = history.filter(h => h.role === 'assistant').map(h => h.content).join(' ').toLowerCase();

      let secteur = 'Non précisé';
      if (userMessages.includes('pharmacie') || userMessages.includes('pharmacy')) secteur = 'Pharmacie';
      else if (userMessages.includes('clinique') || userMessages.includes('clinic')) secteur = 'Clinique';
      else if (userMessages.includes('restaurant')) secteur = 'Restaurant';
      else if (userMessages.includes('boutique') || userMessages.includes('shop')) secteur = 'Boutique';

      let plan = 'Non précisé';
      if (assistantMessages.includes('starter')) plan = 'STARTER - 50 000 FCFA';
      else if (assistantMessages.includes('pro')) plan = 'PRO - 100 000 FCFA';
      else if (assistantMessages.includes('premium')) plan = 'PREMIUM - 200 000 FCFA';

      // Leads par client
      const leadsKey = `leads_${clientId}`;
      let leads = await redisGet(leadsKey) || [];
      if (!Array.isArray(leads)) leads = [];
      if (!leads.find(l => l.numero === clientNum)) {
        leads.push({
          numero: clientNum, secteur, plan,
          langue: langue === 'en' ? '🇬🇧 Anglais' : '🇫🇷 Français',
          client: clientId,
          businessName: config.businessName,
          date: new Date().toISOString(),
          statut: 'À contacter 🟡'
        });
        await redisSet(leadsKey, leads);
      }

      if (config.notifyNumber) {
        await sendWhatsApp(
          config.instance, config.token, config.notifyNumber,
          `🔥 NOUVEAU LEAD — ${config.businessName}\n\n📱 +${clientNum}\n🏢 ${secteur}\n💼 ${plan}\n🌍 ${langue === 'en' ? 'Anglais' : 'Français'}\n⏰ À contacter dans 30 min !`
        );
      }

      console.log(`[LEAD][${clientId}] +${clientNum} | ${secteur} | ${plan}`);
    }

  } catch (err) {
    console.error('Erreur webhook:', err.message);
  }
});

// ─── API Admin — Ajouter un client ────────────────────────────
app.post('/admin/clients', adminAuth, async (req, res) => {
  try {
    const { clientId, businessName, instance, token, notifyNumber } = req.body;
    if (!clientId || !instance || !token) {
      return res.status(400).json({ error: 'clientId, instance et token sont requis' });
    }
    const config = { clientId, businessName: businessName || clientId, instance, token, notifyNumber: notifyNumber || null, active: true, createdAt: new Date().toISOString() };
    await redisSet(`config_${clientId}`, config);

    // Ajouter à la liste des clients
    let clients = await redisGet('clients_list') || [];
    if (!clients.find(c => c.clientId === clientId)) {
      clients.push({ clientId, businessName: config.businessName, createdAt: config.createdAt });
      await redisSet('clients_list', clients);
    }

    console.log(`[ADMIN] Nouveau client : ${clientId}`);
    res.json({
      success: true,
      config,
      webhookUrl: `https://botpme-afrique.onrender.com/webhook/${clientId}`
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API Admin — Liste des clients ────────────────────────────
app.get('/admin/clients', adminAuth, async (req, res) => {
  const clients = await redisGet('clients_list') || [];
  res.json({ clients });
});

// ─── API Leads — Tous les clients ─────────────────────────────
app.get('/leads/all', async (req, res) => {
  try {
    const clients = await redisGet('clients_list') || [];
    let allLeads = [];
    for (const c of clients) {
      const leads = await redisGet(`leads_${c.clientId}`) || [];
      allLeads = allLeads.concat(leads);
    }
    allLeads.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ leads: allLeads, total: allLeads.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API Leads — Par client ────────────────────────────────────
app.get('/leads/:clientId', async (req, res) => {
  const leads = await redisGet(`leads_${req.params.clientId}`) || [];
  res.json({ leads });
});

// ─── API Leads — Mettre à jour statut ─────────────────────────
app.post('/leads/update', async (req, res) => {
  try {
    const { clientId, numero, statut } = req.body;
    const leadsKey = `leads_${clientId}`;
    let leads = await redisGet(leadsKey) || [];
    const index = leads.findIndex(l => l.numero === numero);
    if (index === -1) return res.status(404).json({ error: 'Lead non trouvé' });
    leads[index].statut = statut;
    leads[index].updatedAt = new Date().toISOString();
    await redisSet(leadsKey, leads);
    console.log(`[UPDATE] ${clientId} +${numero} → ${statut}`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ BOTPME AFRIQUE Multi-clients actif sur le port ${PORT}`));
