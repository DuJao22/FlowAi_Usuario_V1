import React from 'react';
import { X, Download, Maximize2, Monitor, Smartphone, Tablet } from 'lucide-react';
import { GeneratedFile } from '../types';

interface PreviewModalProps {
  file: GeneratedFile | null;
  onClose: () => void;
}

const PreviewModal: React.FC<PreviewModalProps> = ({ file, onClose }) => {
  const [viewMode, setViewMode] = React.useState<'desktop' | 'tablet' | 'mobile'>('desktop');

  if (!file) return null;

  const downloadFile = () => {
    const blob = new Blob([file.content], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const containerWidth = {
    desktop: 'w-full',
    tablet: 'w-[768px]',
    mobile: 'w-[375px]'
  };

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/90 backdrop-blur-sm animate-in fade-in duration-300">
      <div className="flex flex-col w-full h-full max-w-[95vw] max-h-[95vh] bg-gray-900 border border-gray-800 rounded-3xl shadow-2xl overflow-hidden">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 bg-gray-900/50 shrink-0">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-purple-600/20 text-purple-400 flex items-center justify-center shadow-inner">
              <Maximize2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-black text-white uppercase tracking-widest leading-none">{file.name}</h2>
              <p className="text-[10px] text-gray-500 mt-1 font-bold uppercase tracking-widest">Visualização em Tempo Real</p>
            </div>
          </div>

          {/* View Mode Selectors */}
          <div className="hidden md:flex items-center bg-gray-950 border border-gray-800 rounded-xl p-1 gap-1">
            <button 
              onClick={() => setViewMode('desktop')}
              className={`p-2 rounded-lg transition-all ${viewMode === 'desktop' ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-500 hover:text-gray-300'}`}
            >
              <Monitor className="w-4 h-4" />
            </button>
            <button 
              onClick={() => setViewMode('tablet')}
              className={`p-2 rounded-lg transition-all ${viewMode === 'tablet' ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-500 hover:text-gray-300'}`}
            >
              <Tablet className="w-4 h-4" />
            </button>
            <button 
              onClick={() => setViewMode('mobile')}
              className={`p-2 rounded-lg transition-all ${viewMode === 'mobile' ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-500 hover:text-gray-300'}`}
            >
              <Smartphone className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button 
              onClick={downloadFile}
              className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-white rounded-xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-95"
            >
              <Download className="w-3.5 h-3.5" />
              Baixar
            </button>
            <button 
              onClick={onClose}
              className="text-gray-500 hover:text-white transition-all p-2 rounded-xl hover:bg-gray-800 active:scale-90"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 bg-gray-950 p-4 flex justify-center overflow-hidden">
          <div className={`h-full bg-white rounded-xl shadow-2xl overflow-hidden transition-all duration-500 ${containerWidth[viewMode]}`}>
            <iframe 
              srcDoc={file.content}
              title="Preview"
              className="w-full h-full border-none"
              sandbox="allow-scripts allow-forms allow-popups allow-modals"
            />
          </div>
        </div>

        {/* Footer Info */}
        <div className="px-6 py-3 border-t border-gray-800 bg-gray-900/50 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 text-[10px] font-bold text-gray-500 uppercase tracking-widest">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            Renderizado com Sucesso
          </div>
          <div className="text-[10px] font-mono text-gray-600">
            {file.content.length} bytes • HTML5 Standard
          </div>
        </div>
      </div>
    </div>
  );
};

export default PreviewModal;
