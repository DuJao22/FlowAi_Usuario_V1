import { MY_API_KEYS } from '../api_keys_list';

/**
 * Gerenciador de Chaves de API (Load Balancer / Rotation)
 */

type KeyListener = (status: string) => void;

class KeyManager {
  private keys: string[] = [];
  private currentIndex: number = 0;
  private failedKeys: Map<string, number> = new Map(); // key -> timestamp of failure
  private listeners: KeyListener[] = [];

  constructor() {
    this.loadKeys();
    // Limpeza periódica de chaves temporariamente falhas (a cada 30 segundos)
    if (typeof window !== 'undefined') {
      setInterval(() => this.cleanupFailedKeys(), 30000);
    }
  }

  private cleanupFailedKeys() {
    const now = Date.now();
    let changed = false;
    for (const [key, timestamp] of this.failedKeys.entries()) {
      // Se passou mais de 60 segundos, tentamos a chave novamente
      // (Reduzido de 120s para 60s para lidar melhor com rate limits por minuto)
      if (now - timestamp > 60000) {
        this.failedKeys.delete(key);
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  private loadKeys() {
    this.keys = []; // Reset

    // 1. Chave do Usuário (LocalStorage) - PRIORIDADE MÁXIMA
    // Permite que o usuário insira sua própria chave nas configurações
    let customKey: string | null = null;
    if (typeof window !== 'undefined') {
        customKey = localStorage.getItem('gemini_api_key');
    }

    if (customKey && customKey.trim().length > 20 && customKey.startsWith('AIza')) {
        this.keys.push(customKey.trim());
    }

    // 2. Chaves do ambiente (Vercel / AI Studio)
    // Removido o uso de process.env conforme solicitado
    let envKeys: string[] = [];

    // 3. Chaves do arquivo físico
    const fileKeys = Array.isArray(MY_API_KEYS) 
      ? (MY_API_KEYS as string[]).map(k => k.trim()).filter(k => k && k.length > 20 && k.startsWith('AIza')) 
      : [];
    
    // Mescla chaves de ambiente e arquivo, mas a customKey fica sempre em primeiro se existir
    const systemKeys = Array.from(new Set([...envKeys, ...fileKeys]));
    this.keys = [...this.keys, ...systemKeys];
    
    // Fallback log
    if (this.keys.length === 0) {
      console.warn("[KeyManager] Nenhuma chave API detectada. Configure nas opções.");
    }
    this.notify();
  }

  public setCustomKey(key: string) {
      // Método chamado quando o usuário salva no SettingsModal
      if (key && key.trim()) {
        localStorage.setItem('gemini_api_key', key.trim());
      } else {
        localStorage.removeItem('gemini_api_key');
      }
      // Recarrega e reseta estado
      this.reset(); 
      this.loadKeys();
  }

  public subscribe(listener: KeyListener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private notify() {
    this.listeners.forEach(l => l(this.getStatus()));
  }

  public getActiveKey(): string {
    if (this.keys.length === 0) return '';
    
    let attempts = 0;
    // Pula chaves que já falharam recentemente
    while (this.failedKeys.has(this.keys[this.currentIndex]) && attempts < this.keys.length) {
      this.currentIndex = (this.currentIndex + 1) % this.keys.length;
      attempts++;
    }
    
    return this.keys[this.currentIndex] || '';
  }

  public markCurrentKeyAsFailed(): boolean {
    if (this.keys.length === 0) return false;
    
    const keyToMark = this.keys[this.currentIndex];
    this.failedKeys.set(keyToMark, Date.now());
    
    console.error(`[KeyManager] Chave #${this.currentIndex + 1} falhou e entrou em cooldown.`);
    
    // Avança para a próxima
    this.currentIndex = (this.currentIndex + 1) % this.keys.length;
    this.notify();
    
    // Retorna true se ainda houver chaves não testadas ou que não falharam
    return this.failedKeys.size < this.keys.length;
  }

  public getStatus() {
    return JSON.stringify({
        total: this.keys.length,
        failed: this.failedKeys.size,
        current: this.currentIndex,
        healthy: Math.max(0, this.keys.length - this.failedKeys.size)
    });
  }

  public getCurrentIndex(): number {
    return this.currentIndex;
  }

  public reset() {
    this.failedKeys.clear();
    this.currentIndex = 0;
    this.notify();
  }

  public getAllKeysStatus() {
      return this.keys.map((key, index) => ({
          index,
          id: key.substring(0, 8) + "...",
          isFailed: this.failedKeys.has(key),
          isActive: index === this.currentIndex
      }));
  }
}

export const keyManager = new KeyManager();