import React, { useState, useRef, useEffect } from 'react';
import JSZip from 'jszip'; 

// --- DEFINICIÓN DE ESTADO (COLA) ---
type FileStatus = 'pending' | 'processing' | 'completed' | 'error';

interface FileQueueItem {
  id: string; 
  file: File;
  status: FileStatus;
  transcription: string;
  generalSummary: string;
  businessSummary: string;
  errorMessage?: string; 
}
// --- ================================== ---

const App: React.FC = () => {
    
    const [fileQueue, setFileQueue] = useState<FileQueueItem[]>([]);
    const [status, setStatus] = useState<string>('Por favor, selecciona uno o más archivos de audio.');
    const [isLoading, setIsLoading] = useState<boolean>(false); 

    // State for permanent instructions
    const [globalInstructions, setGlobalInstructions] = useState<string[]>([]);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [newInstruction, setNewInstruction] = useState('');
    const importFileInputRef = useRef<HTMLInputElement>(null);
    
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
                id: `${file.name}-${new Date().getTime()}`, 
                file: file,
                status: 'pending',
                transcription: '',
                generalSummary: '',
                businessSummary: '',
            };
            newFiles.push(newFileItem);
        }
        
        setFileQueue(prevQueue => [...prevQueue, ...newFiles]);
        setStatus(`${selectedFiles.length} archivo(s) añadido(s) a la cola.`);
    };

    // --- LÓGICA DE PROCESO ---

    const updateFileInQueue = (itemId: string, updates: Partial<FileQueueItem>) => {
        setFileQueue(currentQueue => 
            currentQueue.map(item => 
                item.id === itemId ? { ...item, ...updates } : item
            )
        );
    };

    const processSingleFile = async (itemId: string) => {
        const item = fileQueue.find(i => i.id === itemId);

        // --- ================================== ---
        // ---       ¡ESTA ES LA CORRECCIÓN!      ---
        // --- ================================== ---
        // Ahora permitimos procesar si está 'pending' O 'error'
        if (!item || (item.status !== 'pending' && item.status !== 'error')) {
            return; // No hacer nada si ya está completado o en proceso
        }

        setStatus(`Procesando: ${item.file.name}...`);
        updateFileInQueue(itemId, { status: 'processing', errorMessage: '' });

        try {
            const transcription = await runTranscription(item);
            updateFileInQueue(itemId, { transcription: transcription });
            setStatus(`Transcrito: ${item.file.name}. Generando resúmenes...`);

            const generalSummary = await runGeneralSummary(transcription);
            updateFileInQueue(itemId, { generalSummary: generalSummary });

            const businessSummary = await runBusinessSummary(transcription, globalInstructions);
            updateFileInQueue(itemId, { 
                businessSummary: businessSummary, 
                status: 'completed' 
            });
            
            setStatus(`Completado: ${item.file.name}`);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Error desconocido";
            console.error(`Error procesando ${item.file.name}:`, error);
            // Guardamos el error técnico para nuestra lógica interna
            updateFileInQueue(itemId, { 
                status: 'error', 
                errorMessage: errorMessage 
            });
            // Mostramos un estado simple
            setStatus(`Error en ${item.file.name}, revisa la cola.`);
        }
    };

    const handleProcessAll = async () => {
        const pendingFiles = fileQueue.filter(item => item.status === 'pending');

        if (pendingFiles.length === 0) {
            setStatus("No hay archivos pendientes para procesar.");
            return;
        }
        
        setIsLoading(true); 
        setStatus(`Iniciando procesamiento por lotes de ${pendingFiles.length} archivos...`);

        for (const item of pendingFiles) {
            await processSingleFile(item.id);
            // Mantenemos el retardo de 3s que funcionó para la mayoría
            await new Promise(resolve => setTimeout(resolve, 3000));
        }

        setIsLoading(false); 
        setStatus("Procesamiento por lotes finalizado.");
    };
    
    // --- LÓGICA DE DESCARGA ---

    const generateDocumentContent = (item: FileQueueItem): string => {
        return `
=========================================
REGISTRO DE LLAMADA
=========================================

Archivo Original: ${item.file.name}
Fecha de Procesamiento: ${new Date().toLocaleString()}

-----------------------------------------
1. TRANSCRIPCIÓN COMPLETA
-----------------------------------------

${item.transcription}

-----------------------------------------
2. RESUMEN GENERAL DE LA LLAMADA
-----------------------------------------

${item.generalSummary}

-----------------------------------------
3. RESUMEN DE NEGOCIO (PARA NOTAS RÁPIDAS)
-----------------------------------------

${item.businessSummary}
        `.trim(); 
    };

    const handleGenerateDocument = (item: FileQueueItem) => {
        if (!item || item.status !== 'completed') {
            setStatus("Este archivo no está completado.");
            return;
        }
    
        const docContent = generateDocumentContent(item);
        const blob = new Blob([docContent], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        const baseFilename = item.file.name.split('.').slice(0, -1).join('.') || item.file.name;
        link.download = `${baseFilename}.txt`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        setStatus("Documento generado y descargado.");
    };

    const handleDownloadZip = async () => {
        const completedFiles = fileQueue.filter(item => item.status === 'completed');
        if (completedFiles.length === 0) {
            setStatus("No hay archivos completados para descargar.");
            return;
        }

        setStatus("Generando archivo .zip...");
        setIsLoading(true);

        const zip = new JSZip();

        for (const item of completedFiles) {
            const content = generateDocumentContent(item);
            const baseFilename = item.file.name.split('.').slice(0, -1).join('.') || item.file.name;
            const filename = `${baseFilename}.txt`;
            
            zip.file(filename, content);
        }

        try {
            const zipBlob = await zip.generateAsync({ type: "blob" });
            const url = URL.createObjectURL(zipBlob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `MJTranscripciones_Lote_${new Date().getTime()}.zip`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            setStatus(`${completedFiles.length} archivos descargados en .zip.`);
        } catch (error) {
            console.error("Error generando el .zip:", error);
            setStatus("Error al generar el archivo .zip.");
        } finally {
            setIsLoading(false);
        }
    };


    const handleExportInstructions = () => {
        if (globalInstructions.length === 0) {
            alert("No hay mejoras permanentes para exportar.");
            return;
        }
        const content = globalInstructions.join('\n');
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'mejoras-permanentes.txt';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    const handleImportInstructions = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            const text = e.target?.result as string;
            const lines = text.split('\n').filter(line => line.trim() !== '');
            saveGlobalInstructions(lines);
            alert(`${lines.length} mejoras importadas correctamente.`);
        };
        reader.readAsText(file);
        event.target.value = ''; // Reset input
    };
    
    // --- ESTILOS ---
    const styles: { [key: string]: React.CSSProperties } = {
        container: { fontFamily: 'sans-serif', backgroundColor: '#f0f2f5', minHeight: '100vh', padding: '2rem' },
        header: { textAlign: 'center', marginBottom: '1rem', color: '#1c1e21' },
        card: { backgroundColor: 'white', padding: '2rem', borderRadius: '8px', boxShadow: '0 4px 8px rgba(0,0,0,0.1)', marginBottom: '1.5rem' },
        button: { backgroundColor: '#1877f2', color: 'white', border: 'none', padding: '12px 20px', borderRadius: '6px', fontSize: '16px', cursor: 'pointer', margin: '0.5rem 0', display: 'inline-block', transition: 'background-color 0.3s' },
        buttonDisabled: { backgroundColor: '#a0bdf5', cursor: 'not-allowed' },
        buttonGreen: { backgroundColor: '#36a420' }, 
        buttonSmall: { padding: '8px 12px', fontSize: '14px', marginRight: '0.5rem' }, 
        textarea: { width: '100%', minHeight: '150px', padding: '10px', borderRadius: '6px', border: '1px solid #dddfe2', fontSize: '14px', boxSizing: 'border-box', marginTop: '1rem' },
        status: { textAlign: 'center', margin: '1.5rem 0', color: isLoading ? '#1877f2' : '#606770', fontWeight: 'bold' },
        modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 },
        modalContent: { backgroundColor: 'white', padding: '2rem', borderRadius: '8px', width: '90%', maxWidth: '600px', maxHeight: '80vh', overflowY: 'auto' },
        modalInput: { width: 'calc(100% - 100px)', padding: '10px', borderRadius: '6px', border: '1px solid #dddfe2' },
        modalButton: { padding: '10px', marginLeft: '10px' },
        instructionItem: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px', borderBottom: '1px solid #eee', color: '#1c1e21' },
        deleteButton: { backgroundColor: '#fa3e3e', color: 'white', border: 'none', padding: '5px 10px', borderRadius: '4px', cursor: 'pointer' },
        filenameDisplay: { fontWeight: 'bold', marginBottom: '1Rrem', color: '#606770', padding: '8px 12px', backgroundColor: '#f0f2f5', borderRadius: '6px', border: '1px solid #dddfe2' },
        
        queueContainer: { maxHeight: '400px', overflowY: 'auto', border: '1px solid #dddfe2', borderRadius: '6px', padding: '1rem' },
        queueItem: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem', borderBottom: '1px solid #eee' },
        queueItemName: { flexGrow: 1, marginRight: '1rem', color: '#1c1e21' },
        queueItemStatus: { 
            fontWeight: 'bold', 
            minWidth: '100px', 
            textAlign: 'right',
            marginRight: '1rem',
            padding: '4px 8px',
            borderRadius: '4px',
            fontSize: '12px',
        },
        statusPending: { color: '#606770', backgroundColor: '#f0f2f5' },
        statusProcessing: { color: '#1877f2', backgroundColor: '#e7f3ff' },
        statusCompleted: { color: '#36a420', backgroundColor: '#e6f7e2' },
        statusError: { color: '#fa3e3e', backgroundColor: '#fde7e7' },
        errorText: { fontSize: '12px', color: '#fa3e3e', marginTop: '4px', paddingLeft: '0.75rem', paddingRight: '0.75rem', paddingBottom: '0.75rem' },
    };

    // Helper para obtener el estilo del estado
    const getStatusStyle = (status: FileStatus): React.CSSProperties => {
        switch (status) {
            case 'processing': return styles.statusProcessing;
            case 'completed': return styles.statusCompleted;
            case 'error': return styles.statusError;
            case 'pending':
            default:
                return styles.statusPending;
        }
    };


    return (
        <div style={styles.container}>
            <div style={{maxWidth: '800px', margin: '0 auto'}}>
                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem'}}>
                    <h1 style={{...styles.header, marginBottom: 0, textAlign: 'left'}}>Transcriptor y Resumidor</h1>
                    <button style={styles.button} onClick={() => setIsModalOpen(true)}>Mejoras Permanentes</button>
                </div>

                <div style={styles.card}>
                    <h2>1. Sube tus archivos de audio</h2>
                    <input 
                        type="file" 
                        accept="audio/*" 
                        onChange={handleFileChange} 
                        style={{marginTop: '1rem'}} 
                        multiple={true} 
                    />
                </div>
                
                <p style={styles.status}>{status}</p>

                {fileQueue.length > 0 && (
                    <div style={styles.card}>
                        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem'}}>
                            <h2>2. Cola de Procesamiento ({fileQueue.length} archivos)</h2>
                            <div> 
                                <button 
                                    onClick={handleProcessAll} 
                                    disabled={isLoading}
                                    style={{...styles.button, ...styles.buttonGreen, ...(isLoading ? styles.buttonDisabled : {})}}
                                >
                                    {isLoading ? 'Procesando...' : `Procesar Todos (${fileQueue.filter(f => f.status === 'pending').length})`}
                                </button>
                                {/* Botón de Reintentar Errores Eliminado */}
                            </div>
                        </div>
                        <div style={styles.queueContainer}>
                            {fileQueue.map((item) => (
                                <div key={item.id}>
                                    <div style={styles.queueItem}>
                                        <span style={styles.queueItemName}>{item.file.name}</span>
                                        <span style={{...styles.queueItemStatus, ...getStatusStyle(item.status)}}>
                                            {item.status === 'error' ? 'Error' : item.status === 'completed' ? 'Completado' : item.status === 'processing' ? 'Procesando...' : 'Pendiente'}
                                        </span>
                                        <div>
                                            <button 
                                                onClick={() => processSingleFile(item.id)}
                                                // Habilitado si está 'pending' O 'error'
                                                disabled={isLoading || item.status === 'processing' || item.status === 'completed'}
                                                style={{...styles.button, ...styles.buttonSmall, ...((isLoading || item.status === 'processing' || item.status === 'completed') ? styles.buttonDisabled : {})}}
                                            >
                                                Procesar
                                            </button>
                                            <button 
                                                onClick={() => handleGenerateDocument(item)}
                                                disabled={item.status !== 'completed'}
                                                style={{...styles.button, ...styles.buttonSmall, ...styles.buttonGreen, ...(item.status !== 'completed' ? styles.buttonDisabled : {})}}
                                            >
                                                Descargar
                                            </button>
                                            <button 
                                                onClick={() => setFileQueue(q => q.filter(i => i.id !== item.id))}
                                                disabled={isLoading || item.status === 'processing'}
                                                style={{...styles.button, ...styles.buttonSmall, backgroundColor: '#fa3e3e', ...((isLoading || item.status === 'processing') ? styles.buttonDisabled : {})}}
                                            >
                                                Quitar
                                            </button>
                                        </div>
                                    </div>
                                    
                                    {/* --- ================================== --- */}
                                    {/* ---   MENSAJES DE ERROR MÁS LIMPIOS    --- */}
                                    {/* --- ================================== --- */}
                                    {item.status === 'error' && item.errorMessage && (
                                        <div style={{...styles.queueItem, borderTop: '1px dashed #fde7e7'}}>
                                            {(item.errorMessage.includes('PROHIBITED_CONTENT') || item.errorMessage.includes('blocked')) ? (
                                                // Mensaje para Error Permanente (Bloqueo)
                                                <span style={styles.errorText}>
                                                    <strong>Contenido Prohibido:</strong> Google ha bloqueado este audio. Elimine este archivo o transcriba manualmente.
                                                </span>
                                            ) : (
                                                // Mensaje para Error Temporal (429, Failed to Fetch, o cualquier otro)
                                                <span style={styles.errorText}>
                                                    <strong>Servidor Ocupado:</strong> Intente de nuevo en 1 minuto con el botón "Procesar".
                                                </span>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                        {fileQueue.some(item => item.status === 'completed') && (
                            <div style={{marginTop: '1.5rem', borderTop: '1px solid #eee', paddingTop: '1.5rem'}}>
                                <h2>3. Exportar Lote</h2>
                                <p>Descarga todos los resúmenes completados en un solo archivo .zip.</p>
                                <button 
                                    onClick={handleDownloadZip}
                                    style={{...styles.button, ...styles.buttonGreen}}
                                    disabled={isLoading}
                                >
                                    {isLoading ? 'Generando Zip...' : 'Descargar Todo (.zip)'}
                                </button>
                            </div>
                        )}
                    </div>
                )}

                 {isModalOpen && (
                    <div style={styles.modalOverlay} onClick={() => setIsModalOpen(false)}>
                        <div style={styles.modalContent} onClick={(e) => e.stopPropagation()}>
                            <h2>Mejoras Permanentes</h2>
                            <p>Estas instrucciones se aplicarán a TODOS los resúmenes de negocio futuros.</p>
                            
                            <div style={{ display: 'flex', gap: '1rem', margin: '1rem 0', borderBottom: '1px solid #eee', paddingBottom: '1rem' }}>
                                <input
                                    type="file"
                                    ref={importFileInputRef}
                                    onChange={handleImportInstructions}
                                    accept=".txt"
                                    style={{ display: 'none' }}
                                />
                                <button onClick={() => importFileInputRef.current?.click()} style={{...styles.button, flex: 1, backgroundColor: '#42b72a'}}>
                                    Importar desde Archivo
                                </button>
                                <button onClick={handleExportInstructions} style={{...styles.button, flex: 1}}>
                                    Exportar a Archivo
                                </button>
                            </div>
                            
                            <div style={{ margin: '1rem 0', display: 'flex' }}>
                                <input 
                                    type="text"
                                    value={newInstruction}
                                    onChange={(e) => setNewInstruction(e.target.value)}
                                    placeholder="Añadir nueva instrucción permanente"
                                    style={styles.modalInput}
                                    onKeyPress={(e) => { if (e.key === 'Enter') {
                                        if (newInstruction && !globalInstructions.includes(newInstruction)) {
                                            saveGlobalInstructions([...globalInstructions, newInstruction]);
                                            setNewInstruction('');
                                        }
                                    }}}
                                />
                                <button 
                                    onClick={() => {
                                        if (newInstruction && !globalInstructions.includes(newInstruction)) {
                                            saveGlobalInstructions([...globalInstructions, newInstruction]);
                                            setNewInstruction('');
                                        }
                                    }}
                                    style={{...styles.button, ...styles.modalButton}}
                                >
                                    Añadir
                                </button>
                            </div>
                            <div>
                                {globalInstructions.length === 0 && <p>No hay instrucciones guardadas.</p>}
                                {globalInstructions.map((inst, index) => (
                                    <div key={index} style={styles.instructionItem}>
                                        <span style={{flex: 1, marginRight: '1rem'}}>{inst}</span> 
                                        <button 
                                            onClick={() => {
                                                const updated = globalInstructions.filter((_, i) => i !== index);
                                                saveGlobalInstructions(updated);
                                            }}
                                            style={styles.deleteButton}
                                        >
                                            Eliminar
                                        </button>
                                    </div>
                                ))}
                            </div>
                            <button onClick={() => setIsModalOpen(false)} style={{...styles.button, marginTop: '1rem'}}>Cerrar</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

// --- ================================== ---
// ---   FUNCIONES HELPER DEL BACKEND     ---
// --- ================================== ---

const runTranscription = async (item: FileQueueItem): Promise<string> => {
    const formData = new FormData();
    formData.append('file', item.file); 

    const response = await fetch('https://mjtranscripciones.onrender.com/transcribe', {
        method: 'POST',
        body: formData,
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Error del servidor en transcripción');
    }

    const data = await response.json();
    return data.transcription ?? "";
};

const runGeneralSummary = async (transcription: string): Promise<string> => {
    const body = JSON.stringify({
        transcription: transcription 
    });

    const response = await fetch('https://mjtranscripciones.onrender.com/summarize-general', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Error del servidor en resumen general');
    }

    const data = await response.json();
    return data.summary ?? "";
};

const runBusinessSummary = async (transcription: string, instructions: string[]): Promise<string> => {
    const body = JSON.stringify({
        transcription: transcription,
        instructions: instructions 
    });

    const response = await fetch('https://mjtranscripciones.onrender.com/summarize-business', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Error del servidor en resumen de negocio');
    }

    const data = await response.json();
    return data.summary ?? "";
};


export default App;