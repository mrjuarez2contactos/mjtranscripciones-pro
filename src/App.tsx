import React, { useState, useRef, useEffect } from 'react';
import JSZip from 'jszip'; 

// --- DEFINICIÓN DE ESTADO (COLA) ---
type FileStatus = 'pending' | 'processing' | 'completed' | 'error';
type FileSource = 'local' | 'drive'; 

interface FileQueueItem {
  id: string; 
  file: File | null; 
  driveFileId: string | null; 
  source: FileSource;
  displayName: string; 
  status: FileStatus;
  transcription: string;
  generalSummary: string;
  businessSummary: string;
  errorMessage?: string; 
}

// === NUEVA INTERFAZ PARA ANOTACIONES (VISOR) ===
interface Anotacion {
  contacto: string;
  fecha: string;
  resumen: string;
  url: string;
}

const App: React.FC = () => {
    
    const [fileQueue, setFileQueue] = useState<FileQueueItem[]>([]);
    const [status, setStatus] = useState<string>('Por favor, selecciona archivos de audio o procesa desde Google Drive.');
    const [isLoading, setIsLoading] = useState<boolean>(false); 

    // --- ESTADOS PARA DRIVE ---
    const [showDriveModal, setShowDriveModal] = useState(false);
    const [driveLinks, setDriveLinks] = useState('');

    // State for permanent instructions
    const [globalInstructions, setGlobalInstructions] = useState<string[]>([]);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [newInstruction, setNewInstruction] = useState('');
    const importFileInputRef = useRef<HTMLInputElement>(null);

    // === ESTADOS VISOR DE ANOTACIONES ===
    const [showAnotaciones, setShowAnotaciones] = useState<boolean>(false);
    const [anotaciones, setAnotaciones] = useState<Anotacion[]>([]);
    const [searchTerm, setSearchTerm] = useState<string>('');
    const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
    
    useEffect(() => {
        try {
            const storedInstructions = localStorage.getItem('globalInstructions');
            if (storedInstructions) {
                setGlobalInstructions(JSON.parse(storedInstructions));
            }
        } catch (error) {
            console.error("Failed to parse global instructions from localStorage", error);
        }
    }, []);

    const saveGlobalInstructions = (instructions: string[]) => {
        setGlobalInstructions(instructions);
        localStorage.setItem('globalInstructions', JSON.stringify(instructions));
    };

    const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFiles = event.target.files;
        if (!selectedFiles) return;

        const newFiles: FileQueueItem[] = [];
        for (let i = 0; i < selectedFiles.length; i++) {
            const file = selectedFiles[i];
            const newFileItem: FileQueueItem = {
                id: `${file.name}-${new Date().getTime()}-${i}`, 
                file: file,
                driveFileId: null,
                source: 'local',
                displayName: file.name,
                status: 'pending',
                transcription: '',
                generalSummary: '',
                businessSummary: '',
            };
            newFiles.push(newFileItem);
        }
        
        setFileQueue(prevQueue => [...prevQueue, ...newFiles]);
        setStatus(`${selectedFiles.length} archivo(s) añadido(s) a la cola.`);
        event.target.value = ''; 
    };

    // --- LÓGICA DE PROCESO (CORREGIDA Y ROBUSTA) ---

    // Función auxiliar para actualizar un item específico de manera segura
    const updateItemStatus = (id: string, newStatus: FileStatus, extraData: Partial<FileQueueItem> = {}) => {
        setFileQueue(prevQueue => 
            prevQueue.map(item => 
                item.id === id ? { ...item, status: newStatus, ...extraData } : item
            )
        );
    };

    // Procesa UN solo archivo dada su ID. 
    // Devuelve true si tuvo éxito, false si falló.
    const processItemById = async (itemId: string): Promise<boolean> => {
        // 1. Buscar el item ACTUAL en el estado (para tener la info más reciente)
        let currentItem: FileQueueItem | undefined;
        
        // Usamos un truco para leer el estado actual dentro de una función async sin closures viejos
        // (En una app más grande usaríamos useRef o useReducer, pero esto funciona aquí)
        setFileQueue(prev => {
            currentItem = prev.find(i => i.id === itemId);
            return prev;
        });

        // Pequeña espera para asegurar que currentItem se lea (react batching)
        await new Promise(r => setTimeout(r, 50));

        if (!currentItem) return false;
        if (currentItem.status === 'completed') return true; // Ya estaba listo

        // 2. Marcar como procesando
        setStatus(`Procesando: ${currentItem.displayName}...`);
        updateItemStatus(itemId, 'processing', { errorMessage: '' });

        try {
            let transcription = '';
            let fileName = currentItem.displayName;
            let generalSummary = '';
            let businessSummary = '';

            if (currentItem.source === 'local' && currentItem.file) {
                const transData = await runTranscription(currentItem.file);
                transcription = transData.transcription;
                fileName = transData.fileName;
                
                // Guardar progreso parcial
                updateItemStatus(itemId, 'processing', { transcription, displayName: fileName });
                
                generalSummary = await runGeneralSummary_LEGACY(transcription); 
                updateItemStatus(itemId, 'processing', { generalSummary });
                
                businessSummary = await runBusinessSummary_LEGACY(transcription, globalInstructions); 

            } else if (currentItem.source === 'drive' && currentItem.driveFileId) {
                const data = await runTranscriptionFromDrive(currentItem.driveFileId, globalInstructions);
                transcription = data.transcription;
                fileName = data.fileName;
                generalSummary = data.generalSummary;
                businessSummary = data.businessSummary;
            } else {
                throw new Error("Archivo inválido o sin fuente.");
            }

            // 3. Marcar como completado
            updateItemStatus(itemId, 'completed', {
                displayName: fileName,
                transcription,
                generalSummary,
                businessSummary
            });
            setStatus(`Completado: ${fileName}`);
            return true;

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Error desconocido";
            console.error(`Error en ${currentItem.displayName}:`, error);
            updateItemStatus(itemId, 'error', { errorMessage });
            setStatus(`Error en ${currentItem.displayName}.`);
            return false;
        }
    };

    // ESTA ES LA FUNCIÓN QUE ARREGLA EL PROBLEMA DE "SE PARA"
    const handleProcessAll = async () => {
        // 1. Obtenemos una "foto" de los IDs que faltan (Pendientes O Error)
        //    Así, si el estado cambia mientras procesamos, no perdemos la lista original.
        const idsToProcess = fileQueue
            .filter(item => item.status === 'pending' || item.status === 'error')
            .map(item => item.id);

        if (idsToProcess.length === 0) {
            setStatus("No hay archivos pendientes ni con error para procesar.");
            return;
        }
        
        setIsLoading(true); 
        setStatus(`Iniciando cola de ${idsToProcess.length} archivos...`);

        // 2. Iteramos sobre los IDs fijos
        for (let i = 0; i < idsToProcess.length; i++) {
            const id = idsToProcess[i];
            
            // Procesamos y ESPERAMOS a que termine antes de ir al siguiente
            await processItemById(id);
            
            // Pequeña pausa para respirar y evitar bloqueos de API
            if (i < idsToProcess.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        setIsLoading(false); 
        setStatus("Procesamiento de la cola finalizado.");
    };

    // Wrapper simple para el botón individual
    const handleProcessSingle = async (id: string) => {
        setIsLoading(true);
        await processItemById(id);
        setIsLoading(false);
    };
    
    // --- GOOGLE DRIVE ---

    const parseDriveLinks = (text: string): string[] => {
        const ids: string[] = [];
        const regex = /\/file\/d\/([a-zA-Z0-9_-]{33})|id=([a-zA-Z0-9_-]{33})/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
            ids.push(match[1] || match[2]);
        }
        return [...new Set(ids)];
    };

    const handleProcessDriveLinks = () => {
        const fileIds = parseDriveLinks(driveLinks);
        if (fileIds.length === 0) {
            setStatus("No se encontraron IDs válidos.");
            return;
        }

        const newFiles: FileQueueItem[] = [];
        for (const id of fileIds) {
            const newFileItem: FileQueueItem = {
                id: `drive-${id}-${new Date().getTime()}`, // ID único
                file: null,
                driveFileId: id,
                source: 'drive',
                displayName: `Archivo Drive ...${id.slice(-5)}`, 
                status: 'pending',
                transcription: '',
                generalSummary: '',
                businessSummary: '',
            };
            newFiles.push(newFileItem);
        }

        setFileQueue(prev => [...prev, ...newFiles]);
        setShowDriveModal(false); 
        setDriveLinks(''); 
        setStatus(`${newFiles.length} enlaces añadidos. Click en 'Procesar Todos'.`);
    };

    // === VISOR DE ANOTACIONES (CON PROTECCIÓN ANTI-CRASH) ===
    const handleActualizarDesdeDrive = async () => {
        const sheetsApiUrl = import.meta.env.VITE_SHEETS_API_URL;
        
        if (!sheetsApiUrl) {
            setStatus('Error: URL de API no configurada (.env).');
            return;
        }
        
        setIsLoading(true);
        setStatus('Cargando datos de Sheets...');
        setAnotaciones([]);

        try {
            const response = await fetch(sheetsApiUrl);
            if (!response.ok) throw new Error(`Red: ${response.statusText}`);
            
            const data = await response.json();

            if (data && typeof data === 'object' && data.error) {
                throw new Error(`Apps Script: ${data.error}`);
            }

            if (Array.isArray(data)) {
                setAnotaciones(data);
                setStatus(`${data.length} resúmenes cargados.`);
                setShowAnotaciones(true); 
            } else {
                throw new Error("Formato de datos incorrecto.");
            }
        } catch (error) {
            console.error(error);
            const msg = error instanceof Error ? error.message : 'Error desconocido';
            setStatus(`Error cargando resúmenes: ${msg}`);
        } finally {
            setIsLoading(false);
        }
    };

    const getFilteredAnotaciones = () => {
        if (!Array.isArray(anotaciones)) return [];
        return anotaciones
            .filter(a => 
                (a.contacto || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
                (a.resumen || '').toLowerCase().includes(searchTerm.toLowerCase())
            )
            .sort((a, b) => {
                const dateA = new Date(a.fecha || 0).getTime();
                const dateB = new Date(b.fecha || 0).getTime();
                return sortOrder === 'desc' ? dateB - dateA : dateA - dateB;
            });
    };

    const filteredAnotaciones = getFilteredAnotaciones();

    // --- DESCARGA ---
    const generateDocumentContent = (item: FileQueueItem): string => {
        return `
=========================================
REGISTRO DE LLAMADA
=========================================
Archivo: ${item.displayName}
Fecha: ${new Date().toLocaleString()}

--- 1. TRANSCRIPCIÓN ---
${item.transcription}

--- 2. RESUMEN GENERAL ---
${item.generalSummary}

--- 3. RESUMEN DE NEGOCIO ---
${item.businessSummary}
        `.trim(); 
    };

    const handleGenerateDocument = (item: FileQueueItem) => {
        if (item.status !== 'completed') return;
        const blob = new Blob([generateDocumentContent(item)], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${item.displayName.split('.')[0]}.txt`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const handleDownloadZip = async () => {
        const completed = fileQueue.filter(i => i.status === 'completed');
        if (completed.length === 0) {
            setStatus("Nada para descargar.");
            return;
        }
        setIsLoading(true);
        const zip = new JSZip();
        completed.forEach(item => {
            zip.file(`${item.displayName.split('.')[0]}.txt`, generateDocumentContent(item));
        });
        const blob = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `Lote_Transcripciones_${new Date().getTime()}.zip`;
        link.click();
        setIsLoading(false);
        setStatus("Zip descargado.");
    };

    const handleExportInstructions = () => {
        const blob = new Blob([globalInstructions.join('\n')], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'instrucciones.txt';
        link.click();
    };

    const handleImportInstructions = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const txt = ev.target?.result as string;
            saveGlobalInstructions(txt.split('\n').filter(l => l.trim()));
            alert("Instrucciones importadas.");
        };
        reader.readAsText(file);
        e.target.value = '';
    };

    // --- ESTILOS ---
    const styles: { [key: string]: React.CSSProperties } = {
        container: { fontFamily: 'sans-serif', backgroundColor: '#f0f2f5', minHeight: '100vh', padding: '2rem' },
        header: { textAlign: 'center', marginBottom: '1rem', color: '#1c1e21' },
        card: { backgroundColor: 'white', padding: '2rem', borderRadius: '8px', boxShadow: '0 4px 8px rgba(0,0,0,0.1)', marginBottom: '1.5rem' },
        button: { backgroundColor: '#1877f2', color: 'white', border: 'none', padding: '12px 20px', borderRadius: '6px', fontSize: '16px', cursor: 'pointer', margin: '0.5rem 0', display: 'inline-block' },
        buttonDisabled: { backgroundColor: '#a0bdf5', cursor: 'not-allowed' },
        buttonGreen: { backgroundColor: '#36a420' }, 
        buttonSmall: { padding: '8px 12px', fontSize: '14px', marginRight: '0.5rem' }, 
        textarea: { width: '100%', minHeight: '150px', padding: '10px', borderRadius: '6px', border: '1px solid #dddfe2', fontSize: '14px', marginTop: '1rem' },
        status: { textAlign: 'center', margin: '1.5rem 0', color: isLoading ? '#1877f2' : '#606770', fontWeight: 'bold' },
        modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 },
        modalContent: { backgroundColor: 'white', padding: '2rem', borderRadius: '8px', width: '90%', maxWidth: '600px', maxHeight: '80vh', overflowY: 'auto' },
        modalInput: { width: 'calc(100% - 100px)', padding: '10px', borderRadius: '6px', border: '1px solid #dddfe2' },
        instructionItem: { display: 'flex', justifyContent: 'space-between', padding: '10px', borderBottom: '1px solid #eee' },
        
        // Cola
        queueContainer: { maxHeight: '400px', overflowY: 'auto', border: '1px solid #dddfe2', borderRadius: '6px', padding: '1rem' },
        queueItem: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem', borderBottom: '1px solid #eee', flexWrap: 'wrap' },
        queueItemName: { flexGrow: 1, marginRight: '1rem', wordBreak: 'break-all' },
        queueItemStatus: { fontWeight: 'bold', minWidth: '100px', textAlign: 'right', marginRight: '1rem', padding: '4px 8px', borderRadius: '4px', fontSize: '12px' },
        statusPending: { color: '#606770', backgroundColor: '#f0f2f5' },
        statusProcessing: { color: '#1877f2', backgroundColor: '#e7f3ff' },
        statusCompleted: { color: '#36a420', backgroundColor: '#e6f7e2' },
        statusError: { color: '#fa3e3e', backgroundColor: '#fde7e7' },
        
        // Visor
        visorContainer: { backgroundColor: 'white', padding: '1.5rem', borderRadius: '8px', marginBottom: '1.5rem' },
        visorHeader: { display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem', marginBottom: '1rem' },
        anotacionItem: { border: '1px solid #eee', padding: '1rem', borderRadius: '6px', marginBottom: '1rem' },
        anotacionHeader: { display: 'flex', justifyContent: 'space-between', fontWeight: 'bold', marginBottom: '0.5rem' },
        anotacionResumen: { whiteSpace: 'pre-wrap', lineHeight: '1.6' }
    };

    return (
        <div style={styles.container}>
            <div style={{maxWidth: '800px', margin: '0 auto'}}>
                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '1rem'}}>
                    <h1 style={{...styles.header, margin: 0}}>Transcriptor</h1>
                    <div style={{display: 'flex', gap: '0.5rem'}}>
                        <button style={{...styles.button, margin: 0}} onClick={() => setIsModalOpen(true)}>Mejoras</button>
                        <button 
                            style={{...styles.button, margin: 0, backgroundColor: '#42b72a'}} 
                            onClick={showAnotaciones ? () => setShowAnotaciones(false) : handleActualizarDesdeDrive}
                            disabled={isLoading}
                        >
                            {showAnotaciones ? 'Ocultar' : 'Ver Resúmenes'}
                        </button>
                    </div>
                </div>

                {showAnotaciones ? (
                    <div style={styles.visorContainer}>
                        <div style={styles.visorHeader}>
                            <input 
                                type="text" 
                                placeholder="Buscar..." 
                                value={searchTerm} 
                                onChange={e => setSearchTerm(e.target.value)}
                                style={{...styles.modalInput, width: '100%'}} 
                            />
                            <button onClick={() => setSortOrder(o => o === 'desc' ? 'asc' : 'desc')} style={{...styles.button, margin: 0}}>
                                {sortOrder === 'desc' ? 'Más Reciente' : 'Más Antiguo'}
                            </button>
                        </div>
                        <p style={styles.status}>{status}</p>
                        <div style={{maxHeight: '600px', overflowY: 'auto'}}>
                             {filteredAnotaciones.map((a, i) => (
                                <div key={i} style={styles.anotacionItem}>
                                    <div style={styles.anotacionHeader}>
                                        <span style={{color: '#1877f2'}}>{a.contacto}</span>
                                        <span style={{color: '#606770', fontSize: '0.9rem'}}>{new Date(a.fecha).toLocaleString()}</span>
                                    </div>
                                    <p style={styles.anotacionResumen}>{a.resumen}</p>
                                </div>
                             ))}
                             {filteredAnotaciones.length === 0 && <p style={{textAlign: 'center'}}>No se encontraron resultados.</p>}
                        </div>
                    </div>
                ) : (
                    <>
                        <div style={styles.card}>
                            <h2>1. Archivos</h2>
                            <div style={{display: 'flex', gap: '1rem', flexWrap: 'wrap'}}>
                                <label htmlFor="file-upload" style={{...styles.button, cursor: 'pointer', flex: 1, textAlign: 'center', minWidth: '150px', margin: 0}}>
                                    Subir PC
                                </label>
                                <input id="file-upload" type="file" accept="audio/*" onChange={handleFileChange} style={{display:'none'}} multiple />
                                <button onClick={() => setShowDriveModal(true)} style={{...styles.button, ...styles.buttonGreen, flex: 1, minWidth: '150px', margin: 0}}>
                                    Desde Drive
                                </button>
                            </div>
                        </div>

                        <p style={styles.status}>{status}</p>

                        {fileQueue.length > 0 && (
                            <div style={styles.card}>
                                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem'}}>
                                    <h2 style={{margin: 0}}>Cola ({fileQueue.length})</h2>
                                    <button 
                                        onClick={handleProcessAll} 
                                        disabled={isLoading}
                                        style={{...styles.button, ...styles.buttonGreen, margin: 0, ...(isLoading ? styles.buttonDisabled : {})}}
                                    >
                                        {isLoading ? 'Procesando...' : 'Procesar Todos'}
                                    </button>
                                </div>
                                <div style={styles.queueContainer}>
                                    {fileQueue.map(item => (
                                        <div key={item.id}>
                                            <div style={styles.queueItem}>
                                                <div style={{flex: 1}}>
                                                    <span style={styles.queueItemName}>{item.displayName}</span>
                                                    <br/>
                                                    <span style={
                                                        item.status === 'completed' ? styles.statusCompleted : 
                                                        item.status === 'error' ? styles.statusError : 
                                                        item.status === 'processing' ? styles.statusProcessing : styles.statusPending
                                                    }>
                                                        {item.status}
                                                    </span>
                                                </div>
                                                <div>
                                                    <button 
                                                        onClick={() => handleProcessSingle(item.id)}
                                                        disabled={isLoading || item.status === 'processing'}
                                                        style={{...styles.button, ...styles.buttonSmall, margin: '0 5px', ...(isLoading ? styles.buttonDisabled : {})}}
                                                    >
                                                        Procesar
                                                    </button>
                                                    <button 
                                                        onClick={() => handleGenerateDocument(item)}
                                                        disabled={item.status !== 'completed'}
                                                        style={{...styles.button, ...styles.buttonSmall, ...styles.buttonGreen, margin: '0 5px', ...(item.status !== 'completed' ? styles.buttonDisabled : {})}}
                                                    >
                                                        Bajar
                                                    </button>
                                                    <button 
                                                        onClick={() => setFileQueue(q => q.filter(i => i.id !== item.id))}
                                                        disabled={isLoading}
                                                        style={{...styles.button, ...styles.buttonSmall, backgroundColor: '#fa3e3e', margin: '0 5px', ...(isLoading ? styles.buttonDisabled : {})}}
                                                    >
                                                        X
                                                    </button>
                                                </div>
                                            </div>
                                            {item.errorMessage && <div style={{...styles.errorText, padding: '0 1rem 1rem'}}>{item.errorMessage}</div>}
                                        </div>
                                    ))}
                                </div>
                                {fileQueue.some(i => i.status === 'completed') && (
                                    <div style={{marginTop: '1rem', textAlign: 'right'}}>
                                        <button onClick={handleDownloadZip} style={{...styles.button, ...styles.buttonGreen}}>Descargar ZIP</button>
                                    </div>
                                )}
                            </div>
                        )}
                    </>
                )}

                {/* MODALS */}
                {showDriveModal && (
                    <div style={styles.modalOverlay} onClick={() => setShowDriveModal(false)}>
                        <div style={styles.modalContent} onClick={e => e.stopPropagation()}>
                            <h2>Pegar Enlaces de Drive</h2>
                            <textarea 
                                style={{...styles.textarea, minHeight: '200px'}} 
                                value={driveLinks} 
                                onChange={e => setDriveLinks(e.target.value)}
                                placeholder="https://drive.google.com/..."
                            />
                            <div style={{marginTop: '1rem', textAlign: 'right'}}>
                                <button onClick={() => setShowDriveModal(false)} style={{...styles.button, backgroundColor: '#666', marginRight: '1rem'}}>Cancelar</button>
                                <button onClick={handleProcessDriveLinks} style={{...styles.button, ...styles.buttonGreen}}>Añadir</button>
                            </div>
                        </div>
                    </div>
                )}

                {isModalOpen && (
                    <div style={styles.modalOverlay} onClick={() => setIsModalOpen(false)}>
                        <div style={styles.modalContent} onClick={e => e.stopPropagation()}>
                            <h2>Mejoras Permanentes</h2>
                            <div style={{display:'flex', gap:'10px', marginBottom:'1rem'}}>
                                <button onClick={() => importFileInputRef.current?.click()} style={{...styles.button, flex:1}}>Importar</button>
                                <button onClick={handleExportInstructions} style={{...styles.button, flex:1}}>Exportar</button>
                                <input type="file" ref={importFileInputRef} onChange={(e) => {
                                    if(e.target.files?.[0]) {
                                        const r = new FileReader();
                                        r.onload = ev => saveGlobalInstructions((ev.target?.result as string).split('\n').filter(x=>x));
                                        r.readAsText(e.target.files[0]);
                                    }
                                }} style={{display:'none'}} />
                            </div>
                            <div style={{display:'flex', gap:'10px'}}>
                                <input 
                                    style={{...styles.modalInput, flex:1}} 
                                    value={newInstruction} 
                                    onChange={e => setNewInstruction(e.target.value)}
                                    placeholder="Nueva instrucción..."
                                />
                                <button onClick={() => {
                                    if(newInstruction) {
                                        saveGlobalInstructions([...globalInstructions, newInstruction]);
                                        setNewInstruction('');
                                    }
                                }} style={styles.button}>+</button>
                            </div>
                            <ul style={{paddingLeft: '20px'}}>
                                {globalInstructions.map((inst, i) => (
                                    <li key={i} style={{marginBottom:'5px'}}>
                                        {inst} <span style={{color:'red', cursor:'pointer', marginLeft:'10px'}} onClick={() => saveGlobalInstructions(globalInstructions.filter((_, idx) => idx !== i))}>[x]</span>
                                    </li>
                                ))}
                            </ul>
                            <button onClick={() => setIsModalOpen(false)} style={{...styles.button, marginTop:'1rem'}}>Cerrar</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

// BACKEND HELPERS
const runTranscription = async (file: File) => {
    const fd = new FormData(); fd.append('file', file);
    const res = await fetch('https://mjtranscripciones.onrender.com/transcribe', { method: 'POST', body: fd });
    if (!res.ok) throw new Error('Error transcripción');
    return await res.json();
};

const runTranscriptionFromDrive = async (id: string, inst: string[]) => {
    const res = await fetch('https://mjtranscripciones.onrender.com/transcribe-from-drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drive_file_id: id, instructions: inst })
    });
    if (!res.ok) throw new Error('Error Drive');
    return await res.json();
};

const runGeneralSummary_LEGACY = async (text: string) => {
    const res = await fetch('https://mjtranscripciones.onrender.com/summarize-general', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcription: text })
    });
    if (!res.ok) throw new Error('Error General Summary');
    const d = await res.json();
    return d.summary;
};

const runBusinessSummary_LEGACY = async (text: string, inst: string[]) => {
    const res = await fetch('https://mjtranscripciones.onrender.com/summarize-business', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcription: text, instructions: inst })
    });
    if (!res.ok) throw new Error('Error Business Summary');
    const d = await res.json();
    return d.summary;
};

export default App;