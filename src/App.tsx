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
// --- ================================== ---

const App: React.FC = () => {
    
    const [fileQueue, setFileQueue] = useState<FileQueueItem[]>([]);
    const [status, setStatus] = useState<string>('Por favor, selecciona archivos de audio o procesa desde Google Drive.');
    const [isLoading, setIsLoading] = useState<boolean>(false); 

    // --- ¡NUEVOS ESTADOS PARA DRIVE! ---
    const [showDriveModal, setShowDriveModal] = useState(false);
    const [driveLinks, setDriveLinks] = useState('');
    // --- ============================ ---

    // State for permanent instructions
    const [globalInstructions, setGlobalInstructions] = useState<string[]>([]);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [newInstruction, setNewInstruction] = useState('');
    const importFileInputRef = useRef<HTMLInputElement>(null);

    // === NUEVOS ESTADOS PARA EL VISOR DE ANOTACIONES ===
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
                id: `${file.name}-${new Date().getTime()}`, 
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
        event.target.value = ''; // Resetea el input para permitir cargar el mismo archivo
    };

    // --- LÓGICA DE PROCESO (ACTUALIZADA) ---

    const updateFileInQueue = (itemId: string, updates: Partial<FileQueueItem>) => {
        setFileQueue(currentQueue => 
            currentQueue.map(item => 
                item.id === itemId ? { ...item, ...updates } : item
            )
        );
    };

    const processSingleFile = async (itemId: string) => {
        // Usa una función de callback para asegurar que tenemos el item más actualizado
        let itemToProcess: FileQueueItem | undefined;
        setFileQueue(currentQueue => {
            itemToProcess = currentQueue.find(i => i.id === itemId);
            return currentQueue;
        });

        if (!itemToProcess || (itemToProcess.status !== 'pending' && itemToProcess.status !== 'error')) {
            return; 
        }
        
        const item = itemToProcess; // Renombra para el resto de la función

        setStatus(`Procesando: ${item.displayName}...`);
        updateFileInQueue(itemId, { status: 'processing', errorMessage: '' });

        try {
            let transcription = '';
            let fileName = item.displayName;
            let generalSummary = '';
            let businessSummary = '';

            if (item.source === 'local' && item.file) {
                // Flujo local: 3 llamadas separadas
                const transData = await runTranscription(item.file);
                transcription = transData.transcription;
                fileName = transData.fileName;

                updateFileInQueue(itemId, { transcription: transcription, displayName: fileName });
                setStatus(`Transcrito: ${fileName}. Generando resúmenes...`);

                generalSummary = await runGeneralSummary_LEGACY(transcription); 
                updateFileInQueue(itemId, { generalSummary: generalSummary });
                businessSummary = await runBusinessSummary_LEGACY(transcription, globalInstructions); 


            } else if (item.source === 'drive' && item.driveFileId) {
                // Flujo de Drive: 1 llamada que hace todo
                setStatus(`Procesando (Drive): ${item.displayName}...`);
                const data = await runTranscriptionFromDrive(item.driveFileId, globalInstructions);
                transcription = data.transcription;
                fileName = data.fileName;
                generalSummary = data.generalSummary;
                businessSummary = data.businessSummary;
            } else {
                throw new Error("Archivo inválido en la cola.");
            }

            updateFileInQueue(itemId, { 
                displayName: fileName,
                transcription: transcription,
                generalSummary: generalSummary,
                businessSummary: businessSummary, 
                status: 'completed' 
            });
            
            setStatus(`Completado: ${fileName}`);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Error desconocido";
            console.error(`Error procesando ${item.displayName}:`, error);
            updateFileInQueue(itemId, { 
                status: 'error', 
                errorMessage: errorMessage 
            });
            setStatus(`Error en ${item.displayName}, revisa la cola.`);
        }
    };

    // --- ESTA ES LA VERSIÓN CORREGIDA DE 'handleProcessAll' (LA DE TU ZIP) ---
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
            // Pequeña pausa para evitar rate limiting (opcional pero recomendado)
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        setIsLoading(false); 
        setStatus("Procesamiento por lotes finalizado.");
    };
    
    // --- ¡NUEVAS FUNCIONES DE GOOGLE DRIVE! ---

    const parseDriveLinks = (text: string): string[] => {
        const ids: string[] = [];
        const regex = /\/file\/d\/([a-zA-Z0-9_-]{33})|id=([a-zA-Z0-9_-]{33})/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
            ids.push(match[1] || match[2]);
        }
        return [...new Set(ids)]; // Devuelve solo IDs únicos
    };

    // --- ================================== ---
    // ---     ¡FUNCIÓN DE DRIVE CORREGIDA!     ---
    // --- ================================== ---
    const handleProcessDriveLinks = () => { // Ya no es async
        const fileIds = parseDriveLinks(driveLinks);
        if (fileIds.length === 0) {
            setStatus("No se encontraron IDs de Google Drive válidos en los enlaces.");
            return;
        }

        const newFiles: FileQueueItem[] = [];
        for (const id of fileIds) {
            const newFileItem: FileQueueItem = {
                id: `drive-${id}-${new Date().getTime()}`,
                file: null,
                driveFileId: id,
                source: 'drive',
                displayName: `Archivo de Drive (ID: ...${id.slice(-6)})`, 
                status: 'pending',
                transcription: '',
                generalSummary: '',
                businessSummary: '',
            };
            newFiles.push(newFileItem);
        }

        // 1. Añade los archivos a la cola
        setFileQueue(prevQueue => [...prevQueue, ...newFiles]);
        // 2. Cierra el modal y limpia el texto
        setShowDriveModal(false); 
        setDriveLinks(''); 
        // 3. Informa al usuario. ¡YA NO PROCESA AUTOMÁTICAMENTE!
        setStatus(`${newFiles.length} archivo(s) de Drive añadidos. Presiona 'Procesar Todos' para iniciar.`);
    };
    // --- ================================ ---

    // === ¡¡FUNCIONES DEL VISOR QUE FALTABAN!! ===
    const handleActualizarDesdeDrive = async () => {
        const sheetsApiUrl = import.meta.env.VITE_SHEETS_API_URL;
        
        if (!sheetsApiUrl) {
            setStatus('Error: La URL de la API de Sheets no está configurada.');
            return;
        }
        
        setIsLoading(true);
        setStatus('Actualizando anotaciones desde Google Drive...');
        setAnotaciones([]);

        try {
            const response = await fetch(sheetsApiUrl);
            if (!response.ok) {
                throw new Error(`Error en la red: ${response.statusText}`);
            }
            const data: Anotacion[] | { error: string } = await response.json();

            if (data && typeof data === 'object' && 'error' in data) {
                throw new Error(`Error de Apps Script: ${data.error}`);
            }

            if(Array.isArray(data)) {
                setAnotaciones(data);
                setStatus(`Se cargaron ${data.length} anotaciones.`);
                setShowAnotaciones(true); // Mostrar la vista
            } else {
                throw new Error("La respuesta de la API no fue un array.");
            }
        } catch (error) {
            console.error('Error al obtener anotaciones:', error);
            setStatus(`Error: ${error instanceof Error ? error.message : 'Error desconocido'}`);
        } finally {
            setIsLoading(false);
        }
    };

    // === ¡¡FUNCIÓN DEL VISOR QUE FALTABA!! ===
    const getFilteredAndSortedAnotaciones = () => {
        return anotaciones
            .filter(a => 
                (a.contacto && a.contacto.toLowerCase().includes(searchTerm.toLowerCase())) ||
                (a.resumen && a.resumen.toLowerCase().includes(searchTerm.toLowerCase()))
            )
            .sort((a, b) => {
                const dateA = new Date(a.fecha).getTime();
                const dateB = new Date(b.fecha).getTime();
                if (sortOrder === 'desc') {
                    return dateB - dateA; // Más reciente primero
                } else {
                    return dateA - dateB; // Más antiguo primero
                }
            });
    };
    
    // --- LÓGICA DE DESCARGA (ACTUALIZADA) ---
    const generateDocumentContent = (item: FileQueueItem): string => {
        return `
=========================================
REGISTRO DE LLAMADA
=========================================

Archivo Original: ${item.displayName}
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
        const baseFilename = item.displayName.split('.').slice(0, -1).join('.') || item.displayName;
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
            const baseFilename = item.displayName.split('.').slice(0, -1).join('.') || item.displayName;
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
    
    // === CÁLCULO DEL VISOR (ANTES DEL RENDER) ===
    const filteredAnotaciones = getFilteredAndSortedAnotaciones();
    
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
        filenameDisplay: { fontWeight: 'bold', marginBottom: '1rem', color: '#606770', padding: '8px 12px', backgroundColor: '#f0f2f5', borderRadius: '6px', border: '1px solid #dddfe2' },
        
        queueContainer: { maxHeight: '400px', overflowY: 'auto', border: '1px solid #dddfe2', borderRadius: '6px', padding: '1rem' },
        queueItem: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem', borderBottom: '1px solid #eee', flexWrap: 'wrap' },
        queueItemName: { flexGrow: 1, marginRight: '1rem', color: '#1c1e21', wordBreak: 'break-all' },
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
        errorText: { fontSize: '12px', color: '#fa3e3e', marginTop: '4px', paddingLeft: '0.75rem', paddingRight: '0.75rem', paddingBottom: '0.75rem', width: '100%' },
        queueItemActions: { display: 'flex', flexWrap: 'nowrap', paddingTop: '0.5rem' },

        // === NUEVOS ESTILOS PARA EL VISOR ===
        visorContainer: {
            backgroundColor: 'white', 
            padding: '1.5rem', 
            borderRadius: '8px', 
            boxShadow: '0 4px 8px rgba(0,0,0,0.1)', 
            marginBottom: '1.5rem'
        },
        visorHeader: {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap', // Para responsividad
            gap: '1rem',
            marginBottom: '1rem'
        },
        visorInput: {
            padding: '10px',
            fontSize: '16px',
            borderRadius: '6px',
            border: '1px solid #dddfe2',
            width: '100%',
            maxWidth: '300px', // Limitar en PC
            boxSizing: 'border-box'
        },
        anotacionItem: {
            border: '1px solid #eee',
            padding: '1rem',
            borderRadius: '6px',
            marginBottom: '1rem'
        },
        anotacionHeader: {
            display: 'flex',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '8px',
            fontWeight: 'bold',
            marginBottom: '0.5rem'
        },
        anotacionContacto: {
            fontSize: '1.1rem',
            color: '#1877f2'
        },
        anotacionFecha: {
            color: '#606770',
            fontSize: '0.9rem',
            textAlign: 'right'
        },
        anotacionResumen: {
            whiteSpace: 'pre-wrap', // Respeta saltos de línea
            wordBreak: 'break-word',
            lineHeight: '1.6',
            color: '#1c1e21'
        }
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
                
                {/* === CABECERA FUSIONADA === */}
                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '1rem'}}>
                    <h1 style={{...styles.header, marginBottom: 0, textAlign: 'left'}}>Transcriptor y Resumidor</h1>
                    <div style={{display: 'flex', gap: '0.5rem'}}>
                        <button style={{...styles.button, margin: 0}} onClick={() => setIsModalOpen(true)}>Mejoras</button>
                        <button 
                            style={{...styles.button, margin: 0, backgroundColor: '#42b72a'}} 
                            onClick={showAnotaciones ? () => setShowAnotaciones(false) : handleActualizarDesdeDrive}
                            disabled={isLoading}
                        >
                            {isLoading && status.startsWith('Actualizando') ? 'Cargando...' : (showAnotaciones ? 'Ocultar Resúmenes' : 'Ver Resúmenes')}
                        </button>
                    </div>
                </div>

                {/* === EL NUEVO VISOR DE ANOTACIONES === */}
                {showAnotaciones && (
                    <div style={styles.visorContainer}>
                        <div style={styles.visorHeader}>
                            <input
                                type="text"
                                placeholder="Buscar contacto o resumen..."
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                style={styles.visorInput}
                            />
                            <button 
                                onClick={() => setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc')} 
                                style={{...styles.button, margin: 0, padding: '10px 15px'}}
                            >
                                Ordenar: {sortOrder === 'desc' ? 'Más Reciente' : 'Más Antiguo'}
                            </button>
                        </div>

                        <p style={styles.status}>{status}</p>

                        <div style={{maxHeight: '600px', overflowY: 'auto', paddingRight: '10px'}}>
                            {filteredAnotaciones.length === 0 && !isLoading && <p>No se encontraron anotaciones.</p>}
                            
                            {filteredAnotaciones.map((item, index) => (
                                <div key={index} style={styles.anotacionItem}>
                                    <div style={styles.anotacionHeader}>
                                        <span style={styles.anotacionContacto}>{item.contacto}</span>
                                        <span style={styles.anotacionFecha}>{new Date(item.fecha).toLocaleString()}</span>
                                    </div>
                                    <p style={styles.anotacionResumen}>
                                        {item.resumen || '(Sin resumen)'}
                                    </p> 
                                </div>
                            ))}
                        </div>
                    </div>
                )}


                {/* === UI PRINCIPAL (SE OCULTA SI SE MUESTRA EL VISOR) === */}
                {!showAnotaciones && (
                    <>
                        <div style={styles.card}>
                            <h2>1. Sube tus archivos</h2>
                            <div style={{display: 'flex', gap: '1rem', flexWrap: 'wrap'}}>
                                <label htmlFor="file-upload" style={{...styles.button, cursor: 'pointer', flex: 1, textAlign: 'center', minWidth: '200px', margin: 0}}>
                                    Subir desde PC
                                </label>
                                <input 
                                    id="file-upload"
                                    type="file" 
                                    accept="audio/*" 
                                    onChange={handleFileChange} 
                                    style={{ display: 'none' }} 
                                    multiple={true} 
                                />
                                <button 
                                    onClick={() => setShowDriveModal(true)} 
                                    style={{...styles.button, ...styles.buttonGreen, flex: 1, minWidth: '200px', margin: 0}}
                                >
                                    Procesar desde Google Drive
                                </button>
                            </div>
                        </div>
                        
                        <p style={styles.status}>{status}</p>

                        {fileQueue.length > 0 && (
                            <div style={styles.card}>
                                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '1rem'}}>
                                    <h2 style={{margin: 0}}>2. Cola de Procesamiento ({fileQueue.length})</h2>
                                    <div> 
                                        <button 
                                            onClick={handleProcessAll} 
                                            disabled={isLoading || fileQueue.filter(f => f.status === 'pending').length === 0}
                                            style={{...styles.button, ...styles.buttonGreen, margin: 0, ...( (isLoading || fileQueue.filter(f => f.status === 'pending').length === 0) ? styles.buttonDisabled : {})}}
                                        >
                                            {isLoading ? 'Procesando...' : `Procesar Todos (${fileQueue.filter(f => f.status === 'pending').length})`}
                                        </button>
                                    </div>
                                </div>
                                <div style={styles.queueContainer}>
                                    {fileQueue.map((item) => (
                                        <div key={item.id}>
                                            <div style={styles.queueItem}>
                                                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', flexWrap: 'wrap'}}>
                                                    <span style={styles.queueItemName}>{item.displayName}</span>
                                                    <span style={{...styles.queueItemStatus, ...getStatusStyle(item.status)}}>
                                                        {item.status === 'error' ? 'Error' : item.status === 'completed' ? 'Completado' : item.status === 'processing' ? 'Procesando...' : 'Pendiente'}
                                                    </span>
                                                </div>
                                                <div style={{...styles.queueItemActions, width: '100%', justifyContent: 'flex-end'}}>
                                                    <button 
                                                        onClick={() => processSingleFile(item.id)}
                                                        disabled={isLoading || item.status === 'processing' || item.status === 'completed'}
                                                        style={{...styles.button, ...styles.buttonSmall, margin: 0, ...((isLoading || item.status === 'processing' || item.status === 'completed') ? styles.buttonDisabled : {})}}
                                                    >
                                                        {item.status === 'error' ? 'Reintentar' : 'Procesar'}
                                                    </button>
                                                    <button 
                                                        onClick={() => handleGenerateDocument(item)}
                                                        disabled={item.status !== 'completed'}
                                                        style={{...styles.button, ...styles.buttonSmall, ...styles.buttonGreen, margin: 0, ...(item.status !== 'completed' ? styles.buttonDisabled : {})}}
                                                    >
                                                        Descargar
                                                    </button>
                                                    <button 
                                                        onClick={() => setFileQueue(q => q.filter(i => i.id !== item.id))}
                                                        disabled={isLoading || item.status === 'processing'}
                                                        style={{...styles.button, ...styles.buttonSmall, margin: 0, backgroundColor: '#fa3e3e', ...((isLoading || item.status === 'processing') ? styles.buttonDisabled : {})}}
                                                    >
                                                        Quitar
                                                    </button>
                                                </div>
                                            </div>
                                            
                                            {item.status === 'error' && item.errorMessage && (
                                                <div style={styles.errorText}>
                                                    {(item.errorMessage.includes('PROHIBITED_CONTENT') || item.errorMessage.includes('blocked')) ? (
                                                        <span >
                                                            <strong>Contenido Prohibido:</strong> Google ha bloqueado este audio. Elimine este archivo.
                                                        </span>
                                                    ) : (
                                                        <span>
                                                            <strong>Error:</strong> {item.errorMessage.substring(0, 200)}...
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
                                            style={{...styles.button, ...styles.buttonGreen, margin: 0}}
                                            disabled={isLoading}
                                        >
                                            {isLoading ? 'Generando Zip...' : 'Descargar Todo (.zip)'}
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                    </>
                )}


                 {showDriveModal && (
                    <div style={styles.modalOverlay} onClick={() => setShowDriveModal(false)}>
                        <div style={styles.modalContent} onClick={(e) => e.stopPropagation()}>
                            <h2>Procesar desde Google Drive</h2>
                            <p>Pega tu lista de enlaces de Google Drive aquí (uno por línea).</p>
                            <textarea
                                style={{...styles.textarea, minHeight: '200px'}}
                                placeholder="https...&#10;https...&#10;https..."
                                value={driveLinks}
                                onChange={(e) => setDriveLinks(e.target.value)}
                            />
                            <div style={{marginTop: '1rem', display: 'flex', justifyContent: 'flex-end', gap: '1rem'}}>
                                <button onClick={() => setShowDriveModal(false)} style={{...styles.button, margin: 0, backgroundColor: '#606770'}}>
                                    Cancelar
                                </button>
                                <button 
                                    onClick={handleProcessDriveLinks} 
                                    style={{...styles.button, ...styles.buttonGreen, margin: 0}}
                                    disabled={isLoading || driveLinks.length === 0}
                                >
                                    Añadir a la Cola
                                </button>
                            </div>
                        </div>
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
                                <button onClick={() => importFileInputRef.current?.click()} style={{...styles.button, flex: 1, backgroundColor: '#42b72a', margin: 0}}>
                                    Importar desde Archivo
                                </button>
                                <button onClick={handleExportInstructions} style={{...styles.button, flex: 1, margin: 0}}>
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
                                    style={{...styles.button, ...styles.modalButton, margin: 0}}
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
                            <button onClick={() => setIsModalOpen(false)} style={{...styles.button, marginTop: '1rem', margin: 0}}>Cerrar</button>
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

// Procesa un archivo local
const runTranscription = async (file: File): Promise<{transcription: string, fileName: string}> => {
    const formData = new FormData();
    formData.append('file', file); 

    const response = await fetch('https://mjtranscripciones.onrender.com/transcribe', {
        method: 'POST',
        body: formData,
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Error del servidor en transcripción');
    }

    const data = await response.json();
    return { transcription: data.transcription ?? "", fileName: data.fileName };
};

// Procesa un archivo de Drive
const runTranscriptionFromDrive = async (driveFileId: string, instructions: string[]): Promise<{transcription: string, fileName: string, generalSummary: string, businessSummary: string}> => {
    const body = JSON.stringify({
        drive_file_id: driveFileId,
        instructions: instructions // Pasamos las instrucciones permanentes
    });

    const response = await fetch('https://mjtranscripciones.onrender.com/transcribe-from-drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Error del servidor en transcripción de Drive');
    }

    const data = await response.json();
    return { 
        transcription: data.transcription ?? "", 
        fileName: data.fileName ?? `DriveFile_${driveFileId.slice(-4)}`,
        generalSummary: data.generalSummary ?? "",
        businessSummary: data.businessSummary ?? ""
    };
};

// --- ================================== ---
// ---     ¡FUNCIONES LEGACY CORREGIDAS!    ---
// --- ================================== ---
// Estas funciones SÍ son necesarias para el flujo "Subir desde PC"
const runGeneralSummary_LEGACY = async (transcription: string): Promise<string> => {
    const body = JSON.stringify({
        transcription: transcription 
    });

    // Apunta al endpoint correcto que SÍ existe en main.py
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

const runBusinessSummary_LEGACY = async (transcription: string, instructions: string[]): Promise<string> => {
    const body = JSON.stringify({
        transcription: transcription,
        instructions: instructions 
    });

    // Apunta al endpoint correcto que SÍ existe en main.py
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