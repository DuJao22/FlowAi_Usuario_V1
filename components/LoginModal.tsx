
import React, { useState } from 'react';
import { X, LogIn, UserPlus, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface LoginModalProps {
  onLogin: (user: any, token: string) => void;
}

const LoginModal: React.FC<LoginModalProps> = ({ onLogin }) => {
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setSuccess(null);

    const endpoint = isLogin ? '/api/auth/login' : '/api/auth/signup';

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Ocorreu um erro.');
      }

      if (isLogin) {
        onLogin(data.user, data.token);
      } else {
        setSuccess('Conta criada com sucesso! Agora você pode entrar.');
        setIsLogin(true);
        setPassword('');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl overflow-hidden animate-mobile-up">
        <div className="p-8">
          <div className="flex flex-col items-center mb-8">
            <div className="w-16 h-16 bg-blue-600/20 rounded-2xl flex items-center justify-center mb-4 border border-blue-500/30">
              {isLogin ? <LogIn className="w-8 h-8 text-blue-500" /> : <UserPlus className="w-8 h-8 text-blue-500" />}
            </div>
            <h2 className="text-2xl font-bold text-white">
              {isLogin ? 'Bem-vindo de volta' : 'Criar nova conta'}
            </h2>
            <p className="text-gray-400 text-center mt-2">
              {isLogin 
                ? 'Entre para acessar seus fluxos e automações' 
                : 'Comece a automatizar seus processos com IA'}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-3 text-red-400 text-sm">
                <AlertCircle className="w-5 h-5 shrink-0" />
                {error}
              </div>
            )}

            {success && (
              <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-xl flex items-center gap-3 text-green-400 text-sm">
                <CheckCircle2 className="w-5 h-5 shrink-0" />
                {success}
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-gray-400 uppercase tracking-wider ml-1">
                Usuário
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                placeholder="Seu nome de usuário"
                required
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-gray-400 uppercase tracking-wider ml-1">
                Senha
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                placeholder="Sua senha secreta"
                required
              />
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 text-white font-bold py-3 rounded-xl transition-all flex items-center justify-center gap-2 shadow-lg shadow-blue-900/20"
            >
              {isLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                isLogin ? 'Entrar' : 'Cadastrar'
              )}
            </button>
          </form>

          <div className="mt-8 pt-6 border-t border-gray-800 text-center">
            <p className="text-gray-400 text-sm">
              {isLogin ? 'Não tem uma conta?' : 'Já possui uma conta?'}
              <button
                onClick={() => {
                  setIsLogin(!isLogin);
                  setError(null);
                  setSuccess(null);
                }}
                className="ml-2 text-blue-400 font-semibold hover:text-blue-300 transition-colors"
              >
                {isLogin ? 'Cadastre-se agora' : 'Faça login'}
              </button>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoginModal;
