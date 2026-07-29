// Verifica o token assinado que o plugin GLPI (inc/authtoken.php) mintou
// pro usuário logado - substitui sessão/cookie, já que este serviço roda
// num host diferente do GLPI. Ver a mesma lógica em espelho no PHP.
const crypto = require('crypto');

function base64urlDecode(str) {
   str = str.replace(/-/g, '+').replace(/_/g, '/');
   while (str.length % 4) str += '=';
   return Buffer.from(str, 'base64').toString('utf8');
}

function verifyToken(token, secret) {
   if (!token || typeof token !== 'string' || !token.includes('.')) {
      return null;
   }
   const [payloadB64, sigB64] = token.split('.');
   const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
   const sigOk = sigB64.length === expectedSig.length &&
      crypto.timingSafeEqual(Buffer.from(sigB64), Buffer.from(expectedSig));
   if (!sigOk) return null;

   let payload;
   try {
      payload = JSON.parse(base64urlDecode(payloadB64));
   } catch {
      return null;
   }
   if (!payload.uid || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
   }
   return { id: Number(payload.uid), name: payload.name, initials: payload.initials };
}

function requireAuth(secret) {
   return (req, res, next) => {
      const token = req.headers['x-chatglpi-auth'] || req.query.token;
      const user = verifyToken(token, secret);
      if (!user) {
         res.status(401).json({ error: 'Token inválido ou expirado.' });
         return;
      }
      req.chatUser = user;
      next();
   };
}

module.exports = { verifyToken, requireAuth };
