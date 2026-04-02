import express from "express";
import cors from "cors";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";
import { FlowEngine } from "./services/flowEngine";
import { FlowNode, FlowEdge, LogEntry, GeneratedFile, NodeType } from "./types";

const FLOWS_FILE = path.join(process.cwd(), "flows.json");
const HISTORY_FILE = path.join(process.cwd(), "execution_history.json");
const DB_FILE = path.join(process.cwd(), "database.sqlite");

const INTERNAL_APP_SECRET = "flow-architect-secret-key-local-v1";

// Initialize SQLite Database
const db = new Database(DB_FILE);

// Create users table
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    gemini_api_key TEXT,
    webhook_token TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Migração: Adiciona webhook_token se não existir e gera para usuários antigos
try {
  const columns = db.prepare("PRAGMA table_info(users)").all() as any[];
  if (!columns.find(c => c.name === 'webhook_token')) {
    db.exec("ALTER TABLE users ADD COLUMN webhook_token TEXT UNIQUE");
    console.log("Coluna webhook_token adicionada à tabela users.");
  }
  
  // Gera tokens para usuários que não têm
  const usersWithoutToken = db.prepare("SELECT id FROM users WHERE webhook_token IS NULL").all() as any[];
  for (const user of usersWithoutToken) {
    const token = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    db.prepare("UPDATE users SET webhook_token = ? WHERE id = ?").run(token, user.id);
  }
} catch (e) {
  console.error("Erro na migração de webhook_token:", e);
}

// Create flows table
db.exec(`
  CREATE TABLE IF NOT EXISTS flows (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    nodes TEXT NOT NULL,
    edges TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id)
  )
`);

// Helper para salvar histórico
const saveToHistory = (entry: any) => {
  try {
    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
      const content = fs.readFileSync(HISTORY_FILE, "utf-8");
      history = JSON.parse(content);
    }
    history.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).substring(2, 10),
      timestamp: new Date().toISOString(),
      ...entry
    });
    // Mantém apenas as últimas 50 execuções
    if (history.length > 50) history = history.slice(0, 50);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error("Erro ao salvar histórico:", err);
  }
};

// Helper to load flows from server-side storage
function loadFlows(): Record<string, { nodes: FlowNode[], edges: FlowEdge[] }> {
  try {
    if (fs.existsSync(FLOWS_FILE)) {
      const data = fs.readFileSync(FLOWS_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch (e) {
    console.error("Erro ao carregar fluxos do servidor:", e);
  }
  return {};
}

// Helper to save flows to server-side storage
function saveFlows(flows: Record<string, { nodes: FlowNode[], edges: FlowEdge[] }>) {
  try {
    fs.writeFileSync(FLOWS_FILE, JSON.stringify(flows, null, 2));
  } catch (e) {
    console.error("Erro ao salvar fluxos no servidor:", e);
  }
}

// Função comum para execução de fluxos
async function executeFlow(nodes: FlowNode[], edges: FlowEdge[], initialContext: any = {}, flowId?: string, apiKey?: string) {
  const logs: LogEntry[] = [];
  const files: GeneratedFile[] = [];
  let currentNodes = [...nodes];

  // Callbacks simulados para o FlowEngine no backend
  const setNodes = (updateFn: any) => {
    if (typeof updateFn === 'function') {
      currentNodes = updateFn(currentNodes);
    } else {
      currentNodes = updateFn;
    }
  };

  const addLog = (log: LogEntry) => {
    logs.push(log);
    console.log(`[FlowEngine] [${log.level}] ${log.message}`);
  };

  const onFileGenerated = (file: GeneratedFile) => {
    files.push(file);
    console.log(`[FlowEngine] 💾 Arquivo gerado: ${file.name}`);
  };

  const engine = new FlowEngine(
    currentNodes,
    edges,
    setNodes,
    addLog,
    onFileGenerated,
    apiKey
  );

  // Injeta os dados da requisição no contexto inicial
  engine.context['webhook_data'] = initialContext;

  // Executa o fluxo
  await engine.run();

  const result = {
    success: true,
    flowId,
    timestamp: new Date().toISOString(),
    webhook_received: initialContext,
    logs,
    files,
    finalNodesState: currentNodes
  };

  saveToHistory(result);
  return result;
}

async function startServer() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  // Auth Endpoints
  app.post("/api/auth/signup", async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ error: "Usuário e senha são obrigatórios." });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const webhookToken = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
      const stmt = db.prepare("INSERT INTO users (username, password, webhook_token) VALUES (?, ?, ?)");
      
      try {
        const result = stmt.run(username, hashedPassword, webhookToken);
        const token = jwt.sign({ userId: result.lastInsertRowid, username }, INTERNAL_APP_SECRET, { expiresIn: "7d" });
        res.json({ success: true, token, user: { id: result.lastInsertRowid, username, webhook_token: webhookToken } });
      } catch (err: any) {
        if (err.message.includes("UNIQUE constraint failed")) {
          return res.status(400).json({ error: "Usuário já existe." });
        }
        throw err;
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ error: "Usuário e senha são obrigatórios." });
      }

      const user: any = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
      if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: "Usuário ou senha inválidos." });
      }

      const token = jwt.sign({ userId: user.id, username: user.username }, INTERNAL_APP_SECRET, { expiresIn: "7d" });
      res.json({ 
        success: true, 
        token, 
        user: { 
          id: user.id, 
          username: user.username, 
          gemini_api_key: user.gemini_api_key,
          webhook_token: user.webhook_token
        } 
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Middleware to verify JWT
  const authenticateToken = (req: any, res: any, next: any) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.sendStatus(401);

    jwt.verify(token, INTERNAL_APP_SECRET, (err: any, user: any) => {
      if (err) return res.sendStatus(403);
      req.user = user;
      next();
    });
  };

  // User Settings Endpoints
  app.get("/api/user/settings", authenticateToken, (req: any, res) => {
    try {
      const user: any = db.prepare("SELECT gemini_api_key FROM users WHERE id = ?").get(req.user.userId);
      res.json({ gemini_api_key: user?.gemini_api_key });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/user/settings", authenticateToken, (req: any, res) => {
    try {
      const { gemini_api_key } = req.body;
      db.prepare("UPDATE users SET gemini_api_key = ? WHERE id = ?").run(gemini_api_key, req.user.userId);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Endpoint para ver o histórico de execuções
  app.get("/api/history", (req, res) => {
    if (fs.existsSync(HISTORY_FILE)) {
      const content = fs.readFileSync(HISTORY_FILE, "utf-8");
      res.json(JSON.parse(content));
    } else {
      res.json([]);
    }
  });

  // Endpoint para salvar um fluxo no servidor e obter um Webhook ID
  app.post("/api/save-flow", authenticateToken, (req: any, res) => {
    try {
      const { id, nodes, edges, name } = req.body;
      if (!id || !nodes || !edges) {
        return res.status(400).json({ error: "ID, nodes e edges são obrigatórios." });
      }

      const userId = req.user.userId;
      const username = req.user.username;
      
      const existing = db.prepare("SELECT id FROM flows WHERE id = ?").get(id);
      
      if (existing) {
        db.prepare("UPDATE flows SET nodes = ?, edges = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?")
          .run(JSON.stringify(nodes), JSON.stringify(edges), id, userId);
      } else {
        db.prepare("INSERT INTO flows (id, user_id, name, nodes, edges) VALUES (?, ?, ?, ?, ?)")
          .run(id, userId, name || "Sem nome", JSON.stringify(nodes), JSON.stringify(edges));
      }

      res.json({ 
        success: true, 
        message: "Fluxo salvo no servidor.", 
        webhookUrl: `/api/trigger/${username}/${id}?token=${req.user.webhook_token || ''}` 
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Endpoint de Gatilho (Webhook) - Executa um fluxo salvo via GET ou POST
  app.all("/api/trigger/:username/:flowId", async (req, res) => {
    const { username, flowId } = req.params;
    const { token } = req.query;
    
    console.log(`[Webhook] Recebido gatilho para o usuário ${username}, fluxo: ${flowId}`);
    
    try {
      const user: any = db.prepare("SELECT id, gemini_api_key, webhook_token FROM users WHERE username = ?").get(username);
      if (!user) {
        return res.status(404).json({ error: "Usuário não encontrado." });
      }

      // Validação do Token Único
      if (!token || token !== user.webhook_token) {
        console.warn(`[Webhook] Tentativa de acesso não autorizada para ${username}. Token inválido.`);
        return res.status(401).json({ error: "Token de acesso inválido ou ausente." });
      }

      // Validação da Chave API (Obrigatória para Webhooks conforme solicitado)
      if (!user.gemini_api_key) {
        return res.status(400).json({ 
          error: "Chave API Gemini não configurada para este usuário. Webhooks exigem uma chave própria por segurança." 
        });
      }

      const flowRow: any = db.prepare("SELECT nodes, edges FROM flows WHERE id = ? AND user_id = ?").get(flowId, user.id);

      if (!flowRow) {
        console.error(`[Webhook] Fluxo ${flowId} não encontrado para o usuário ${username}.`);
        return res.status(404).json({ error: "Fluxo não encontrado no servidor." });
      }

      const flow = {
        nodes: JSON.parse(flowRow.nodes),
        edges: JSON.parse(flowRow.edges)
      };

      const webhookData = { 
          query: req.query, 
          body: req.body,
          headers: req.headers,
          method: req.method
      };

      const result = await executeFlow(flow.nodes, flow.edges, webhookData, flowId, user.gemini_api_key);
      res.json(result);

    } catch (error: any) {
      console.error("Erro no gatilho do fluxo:", error);
      const errorResult = {
        success: false,
        flowId,
        error: error.message,
        timestamp: new Date().toISOString(),
        logs: [],
        files: []
      };
      saveToHistory(errorResult);
      res.status(500).json(errorResult);
    }
  });

  // API Endpoint para executar o fluxo via POST direto (sem salvar)
  app.post("/api/execute-flow", async (req, res) => {
    try {
      const { nodes, edges, data } = req.body;

      if (!nodes || !Array.isArray(nodes)) {
        return res.status(400).json({ error: "O corpo da requisição deve conter um array 'nodes'." });
      }

      if (!edges || !Array.isArray(edges)) {
        return res.status(400).json({ error: "O corpo da requisição deve conter um array 'edges'." });
      }

      const result = await executeFlow(nodes, edges, data || {});
      res.json(result);

    } catch (error: any) {
      console.error("Erro na execução do fluxo via API:", error);
      res.status(500).json({
        success: false,
        error: error.message || "Erro interno na execução do fluxo."
      });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = 3000;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
