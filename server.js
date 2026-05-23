const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ULTRAMSG_INSTANCE = 'instance177004';
const ULTRAMSG_TOKEN = 'hf70v24381ystjv6';
const UPSTASH_URL = process.env.UPSTASH_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_TOKEN;
const NOTIFY_NUMBER = '22996003114@c.us';

// ✅ Upstash Redis helpers
async function redisGet(key) {
  try {
    const res = await axios.get(
      `${UPSTASH_URL}/get/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
    return res.data.result ? JSON.parse(res.data.result) : null;
  } catch { return null; }
}

async function redisSet(key, value) {
  await axios.post(
    `${UPSTASH_URL}/set/${encodeURIComponent(key)}`,
    JSON.stringify(JSON.stringify(value)),
    { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

// ✅ Envoyer un message WhatsApp
async function sendWhatsApp(to, body) {
  await axios.post(
    `https://api.ultramsg.com/${ULTRAMSG_INSTANCE}/messages/chat`,
    { token: ULTRAMSG_TOKEN, to, body }
  );
}

// ✅ Page d'accueil
app.get('/', (req, res) => {
  res.send(`
    <h2>🤖 BOTPME AFRIQUE</h2>
    <p>Bot WhatsApp actif ✅</p>
    <p>Numéro : +229 97008962</p>
    <p>Instance UltraMsg : ${ULTRAMSG_INSTANCE}</p>
  `);
});

// ✅ Webhook principal
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const data = req.body;

    if (!data.data || data.data.type !== 'chat' || data.data.fromMe === true) return;

    const userMessage = data.data.body;
    const from = data.data.from;
    const msgLower = userMessage.toLowerCase().trim();
    const now = Date.now();
    const VINGT_QUATRE_H = 24 * 60 * 60 * 1000;

    // Récupérer session
    let session = await redisGet(from) || {};
    let history = session.history || [];
    const lastActive = session.lastActive || 0;

    // Réinitialiser si inactif 24h
    if (history.length > 0 && (now - lastActive) > VINGT_QUATRE_H) {
      history = [];
      session.langue = null;
    }

    // ✅ Détection langue sans appel API
    let langue = session.langue || null;
    if (!langue || history.length === 0) {
      const patternEn = /\b(hello|hi|hey|good|morning|evening|help|yes|no|want|need|price|how|what|my|i am|i'm|please|thanks|thank you|okay|ok|sure|great|perfect|nice|i need|i want)\b/i;
      langue = patternEn.test(userMessage) ? 'en' : 'fr';
      session.langue = langue;
    }

    history.push({ role: 'user', content: userMessage });
    if (history.length > 20) history = history.slice(-20);

    // ✅ Prompt selon langue
    const systemPrompt = langue === 'en'
      ? `You are BOTPME, a WhatsApp assistant for a business automation agency in Africa.

STRICT RULES:
- ALWAYS respond in English, maximum 3 lines
- NEVER repeat the welcome message if the conversation has already started
- Read the conversation history and continue exactly where you left off
- Never ask the same question twice
- If the client switches to French, respond in French immediately

SALES SCRIPT (follow in order):
1. First message → Welcome warmly and ask: "What is your business sector? (pharmacy, clinic, restaurant, shop, other)"
2. After sector → Ask: "How many customer messages per day? A) Less than 20  B) Between 20 and 100  C) More than 100"
3. After A/B/C → Recommend:
   A = STARTER 50,000 FCFA/month
   B = PRO 100,000 FCFA/month
   C = PREMIUM 200,000 FCFA/month
4. After recommendation → "Would you like a 7-day FREE trial? Reply YES"
5. After YES → "🎉 A consultant will contact you within 30 minutes. Thank you!"

IMPORTANT: The history below shows everything already said. Do not start over.`

      : `Tu es BOTPME, assistant WhatsApp d'une agence d'automatisation en Afrique.

RÈGLES ABSOLUES :
- Réponds TOUJOURS en français, maximum 3 lignes
- Ne répète JAMAIS le message de bienvenue si la conversation est déjà commencée
- Lis l'historique de la conversation et continue exactement là où tu en es
- Ne pose jamais deux fois la même question
- Si le client écrit en anglais, bascule immédiatement en anglais

SCRIPT À SUIVRE DANS L'ORDRE :
1. Premier message → Saluer UNE SEULE FOIS et demander le secteur : pharmacie, clinique, restaurant, boutique ou autre ?
2. Après secteur reçu → Demander : "Combien de messages par jour ? A) Moins de 20  B) Entre 20 et 100  C) Plus de 100"
3. Après A/B/C reçu → Recommander :
   A = STARTER 50 000 FCFA/mois
   B = PRO 100 000 FCFA/mois
   C = PREMIUM 200 000 FCFA/mois
4. Après recommandation → "Voulez-vous 7 jours d'essai GRATUIT ? Répondez OUI"
5. Après OUI → "🎉 Un conseiller vous contacte dans 30 min. Merci !"

IMPORTANT : L'historique ci-dessous montre tout ce qui a déjà été dit. Ne recommence pas depuis le début.`;

    // ✅ Appel Groq unique
    const groqResponse = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: systemPrompt },
          ...history
        ],
        max_tokens: 300
      },
      {
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const reply = groqResponse.data.choices[0].message.content;

    // Sauvegarder session
    history.push({ role: 'assistant', content: reply });
    await redisSet(from, { history, lastActive: now, langue: session.langue });

    // Envoyer réponse au client
    await sendWhatsApp(from, reply);

    // ✅ Détecter OUI / YES
    const clientDitOui = msgLower === 'oui' || msgLower === 'yes' ||
                         msgLower.includes('oui') || msgLower.includes('yes');

    if (clientDitOui) {
      const clientNum = from.replace('@c.us', '');
      const allText = history.map(h => h.content).join(' ').toLowerCase();

      let secteur = 'Non précisé';
      let plan = 'Non précisé';
      if (allText.includes('pharmacie') || allText.includes('pharmacy')) secteur = 'Pharmacie';
      else if (allText.includes('clinique') || allText.includes('clinic')) secteur = 'Clinique';
      else if (allText.includes('restaurant')) secteur = 'Restaurant';
      else if (allText.includes('boutique') || allText.includes('shop')) secteur = 'Boutique';
      if (allText.includes('starter')) plan = 'STARTER - 50 000 FCFA';
      else if (allText.includes('pro')) plan = 'PRO - 100 000 FCFA';
      else if (allText.includes('premium')) plan = 'PREMIUM - 200 000 FCFA';

      // Sauvegarder lead
      let leads = await redisGet('leads_list') || [];
      if (!Array.isArray(leads)) leads = [];
      if (!leads.find(l => l.numero === clientNum)) {
        leads.push({
          numero: clientNum,
          secteur,
          plan,
          langue: langue === 'en' ? '🇬🇧 Anglais' : '🇫🇷 Français',
          date: new Date().toISOString(),
          statut: 'Essai accepté 🟢'
        });
        await redisSet('leads_list', leads);
      }

      // Notification WhatsApp
      await sendWhatsApp(
        NOTIFY_NUMBER,
        `🔥 NOUVEAU LEAD BOTPME !\n\n📱 Numéro : +${clientNum}\n🏢 Secteur : ${secteur}\n💼 Plan : ${plan}\n🌍 Langue : ${langue === 'en' ? 'Anglais' : 'Français'}\n⏰ À contacter dans 30 minutes !`
      );
    }

  } catch (err) {
    console.error('Erreur webhook:', err.message);
  }
});

// ✅ API pour le dashboard
app.get('/leads', async (req, res) => {
  const leads = await redisGet('leads_list') || [];
  res.json({ leads });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ BOTPME AFRIQUE actif sur le port ${PORT}`));
