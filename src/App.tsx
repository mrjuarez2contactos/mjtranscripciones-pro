import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI } from '@google/genai';

// Helper function to convert a file to a base64 string
const fileToBase64 = (file: File | Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => {
            // result is a data URL like "data:audio/mp3;base64,..."
            // We only want the base64 part
            const result = reader.result as string;
            resolve(result.split(',')[1]);
        };
        reader.onerror = (error) => reject(error);
    });
};

const App: React.FC = () => {
    const [file, setFile] = useState<File | null>(null);
    const [transcription, setTranscription] = useState<string>('');
    const [generalSummary, setGeneralSummary] = useState<string>('');
    const [businessSummary, setBusinessSummary] = useState<string>('');
    const [status, setStatus] = useState<string>('Por favor, selecciona un archivo de audio y presiona "Transcribir".');
    const [isLoading, setIsLoading] = useState<boolean>(false);

    // State for summary improvements
    const [improvementInstruction, setImprovementInstruction] = useState('');
    const [isRecording, setIsRecording] = useState(false);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const audioInstructionBlobRef = useRef<Blob | null>(null);

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
        const selectedFile = event.target.files?.[0];
        if (selectedFile) {
            setFile(selectedFile);
            setTranscription('');
            setGeneralSummary('');
            setBusinessSummary('');
            setStatus(`Archivo seleccionado: ${selectedFile.name}`);
        }
    };

    const handleTranscribe = async () => {
        if (!file) {
            setStatus('Por favor, selecciona un archivo primero.');
            return;
        }

        setIsLoading(true);
        setStatus(`Transcribiendo ${file.name}...`);
        setTranscription('');
        setGeneralSummary('');
        setBusinessSummary('');

        try {
            // Fix: API key must be retrieved from process.env.API_KEY as per coding guidelines.
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            const base64Audio = await fileToBase64(file);
            const audioPart = {
                inlineData: {
                    data: base64Audio,
                    mimeType: file.type,
                },
            };
            
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [{ parts: [audioPart, {text: "Transcribe this audio recording."}] }],
            });
            
            setTranscription(response.text ?? "");
            setStatus('Transcripción completa. Ahora puedes generar un resumen general.');
        } catch (error) {
            console.error('Transcription error:', error);
            setStatus(`Error en la transcripción: ${error instanceof Error ? error.message : 'Unknown error'}`);
        } finally {
            setIsLoading(false);
        }
    };

    const handleGenerateGeneralSummary = async () => {
        if (!transcription) {
            setStatus('No hay transcripción para resumir.');
            return;
        }

        setIsLoading(true);
        setStatus('Generando resumen general...');
        setGeneralSummary('');

        try {
            // Fix: API key must be retrieved from process.env.API_KEY as per coding guidelines.
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            const prompt = `Basado en la siguiente transcripción de una llamada, genera un resumen general claro y conciso. El resumen debe identificar los puntos clave, las acciones a seguir y el sentimiento general de la llamada, sin asumir ningún contexto de negocio específico.
            
            Transcripción:
            ---
            ${transcription}
            ---
            `;

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-pro',
                contents: prompt,
            });

            setGeneralSummary(response.text ?? "");
            setStatus('Resumen general generado. Ahora puedes generar el resumen de negocio.');
        } catch (error) {
            console.error('General summary generation error:', error);
            setStatus(`Error generando el resumen general: ${error instanceof Error ? error.message : 'Unknown error'}`);
        } finally {
            setIsLoading(false);
        }
    };

    const handleGenerateBusinessSummary = async () => {
        if (!transcription) {
            setStatus('No hay transcripción para resumir.');
            return;
        }

        setIsLoading(true);
        setStatus('Generando resumen de negocio...');
        setBusinessSummary('');

        try {
            // Fix: API key must be retrieved from process.env.API_KEY as per coding guidelines.
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            const permanentInstructionsText = globalInstructions.length > 0
                ? `Para este resumen, aplica estas reglas e instrucciones permanentes en todo momento: ${globalInstructions.join('. ')}`
                : '';

            const prompt = `Basado en la siguiente transcripción de una llamada, genera un resumen de negocio claro y conciso. El resumen debe identificar los puntos clave y las acciones a seguir, enfocándose en temas relevantes para un negocio de mariscos.
            
            ${permanentInstructionsText}

            Transcripción:
            ---
            ${transcription}
            ---
            `;

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-pro',
                contents: prompt,
            });

            setBusinessSummary(response.text ?? "");
            setStatus('Resumen de negocio generado. Puedes mejorarlo a continuación.');
        } catch (error) {
            console.error('Business summary generation error:', error);
            setStatus(`Error generando el resumen de negocio: ${error instanceof Error ? error.message : 'Unknown error'}`);
        } finally {
            setIsLoading(false);
        }
    };

    const handleImproveSummary = async (isPermanent: boolean) => {
        if (!businessSummary) {
            setStatus('Primero debes generar un resumen de negocio para poder mejorarlo.');
            return;
        }
        if (!improvementInstruction && !audioInstructionBlobRef.current) {
            setStatus('Por favor, escribe o graba una instrucción para la mejora.');
            return;
        }

        setIsLoading(true);
        setStatus('Aplicando mejoras al resumen de negocio...');

        try {
            // Fix: API key must be retrieved from process.env.API_KEY as per coding guidelines.
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            const instruction = improvementInstruction || 'la instrucción fue grabada por audio.';
            const permanentInstructionsText = globalInstructions.length > 0
                ? `Adicionalmente, aplica estas reglas e instrucciones permanentes en todo momento: ${globalInstructions.join('. ')}`
                : '';

            const promptParts: any[] = [{ text: `
                Necesito que mejores el siguiente "Resumen de Negocio Actual" basándote en la "Transcripción Original" y la "Instrucción de Mejora" que te proporciono. 
                
                ${permanentInstructionsText}

                Instrucción de Mejora: "${instruction}"

                Transcripción Original:
                ---
                ${transcription}
                ---

                Resumen de Negocio Actual:
                ---
                ${businessSummary}
                ---

                Por favor, genera el "Nuevo Resumen de Negocio Mejorado":
            `}];

            if (audioInstructionBlobRef.current) {
                const base64Audio = await fileToBase64(audioInstructionBlobRef.current);
                promptParts.push({
                    inlineData: {
                        data: base64Audio,
                        mimeType: audioInstructionBlobRef.current.type,
                    }
                });
            }

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-pro',
                contents: [{ parts: promptParts }],
            });
            
            setBusinessSummary(response.text ?? "");
            setStatus('Resumen de negocio mejorado exitosamente.');

            if (isPermanent && improvementInstruction) {
                if (!globalInstructions.includes(improvementInstruction)) {
                    saveGlobalInstructions([...globalInstructions, improvementInstruction]);
                }
            }
            setImprovementInstruction('');
            audioInstructionBlobRef.current = null;
        } catch (error) {
            console.error('Improvement error:', error);
            setStatus(`Error mejorando el resumen: ${error instanceof Error ? error.message : 'Unknown error'}`);
        } finally {
            setIsLoading(false);
        }
    };

    const toggleRecording = async () => {
        if (isRecording) {
            mediaRecorderRef.current?.stop();
            setIsRecording(false);
            setStatus('Grabación finalizada. Presiona "Aplicar" para usarla.');
        } else {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                mediaRecorderRef.current = new MediaRecorder(stream);
                audioChunksRef.current = [];
                mediaRecorderRef.current.ondataavailable = (event) => audioChunksRef.current.push(event.data);
                mediaRecorderRef.current.onstop = () => {
                    const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
                    audioInstructionBlobRef.current = audioBlob;
                    stream.getTracks().forEach(track => track.stop());
                };
                mediaRecorderRef.current.start();
                setIsRecording(true);
                setStatus('Grabando instrucciones de audio... Presiona de nuevo para parar.');
            } catch (error) {
                console.error("Error accessing microphone:", error);
                setStatus("No se pudo acceder al micrófono. Por favor, verifica los permisos.");
            }
        }
    };

    const handleGenerateDocument = () => {
        if (!file || !transcription || !generalSummary || !businessSummary) {
            setStatus("Faltan datos para generar el documento.");
            return;
        }
    
        const docContent = `
=========================================
REGISTRO DE LLAMADA
=========================================

Archivo Original: ${file.name}
Fecha de Procesamiento: ${new Date().toLocaleString()}

-----------------------------------------
1. TRANSCRIPCIÓN COMPLETA
-----------------------------------------

${transcription}

-----------------------------------------
2. RESUMEN GENERAL DE LA LLAMADA
-----------------------------------------

${generalSummary}

-----------------------------------------
3. RESUMEN DE NEGOCIO (PARA NOTAS RÁPIDAS)
-----------------------------------------

${businessSummary}
        `;
    
        const blob = new Blob([docContent.trim()], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        const baseFilename = file.name.split('.').slice(0, -1).join('.') || file.name;
        link.download = `${baseFilename}.txt`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        setStatus("Documento generado y descargado.");
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
    
    // Styles
    const styles: { [key: string]: React.CSSProperties } = {
        container: { fontFamily: 'sans-serif', backgroundColor: '#f0f2f5', minHeight: '100vh', padding: '2rem' },
        header: { textAlign: 'center', marginBottom: '1rem', color: '#1c1e21' },
        card: { backgroundColor: 'white', padding: '2rem', borderRadius: '8px', boxShadow: '0 4px 8px rgba(0,0,0,0.1)', marginBottom: '1.5rem' },
        button: { backgroundColor: '#1877f2', color: 'white', border: 'none', padding: '12px 20px', borderRadius: '6px', fontSize: '16px', cursor: 'pointer', margin: '0.5rem 0', display: 'inline-block', transition: 'background-color 0.3s' },
        buttonDisabled: { backgroundColor: '#a0bdf5', cursor: 'not-allowed' },
        textarea: { width: '100%', minHeight: '150px', padding: '10px', borderRadius: '6px', border: '1px solid #dddfe2', fontSize: '14px', boxSizing: 'border-box', marginTop: '1rem' },
        status: { textAlign: 'center', margin: '1.5rem 0', color: isLoading ? '#1877f2' : '#606770', fontWeight: 'bold' },
        modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 },
        modalContent: { backgroundColor: 'white', padding: '2rem', borderRadius: '8px', width: '90%', maxWidth: '600px', maxHeight: '80vh', overflowY: 'auto' },
        modalInput: { width: 'calc(100% - 100px)', padding: '10px', borderRadius: '6px', border: '1px solid #dddfe2' },
        modalButton: { padding: '10px', marginLeft: '10px' },
        instructionItem: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px', borderBottom: '1px solid #eee', color: '#1c1e21' },
        deleteButton: { backgroundColor: '#fa3e3e', color: 'white', border: 'none', padding: '5px 10px', borderRadius: '4px', cursor: 'pointer' },
        filenameDisplay: { fontWeight: 'bold', marginBottom: '1rem', color: '#606770', padding: '8px 12px', backgroundColor: '#f0f2f5', borderRadius: '6px', border: '1px solid #dddfe2' }
    };

    return (
        <div style={styles.container}>
            <div style={{maxWidth: '800px', margin: '0 auto'}}>
                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem'}}>
                    <h1 style={{...styles.header, marginBottom: 0, textAlign: 'left'}}>Transcriptor y Resumidor</h1>
                    <button style={styles.button} onClick={() => setIsModalOpen(true)}>Mejoras Permanentes</button>
                </div>

                <div style={styles.card}>
                    <h2>1. Sube tu archivo de audio</h2>
                    <input type="file" accept="audio/*" onChange={handleFileChange} style={{marginTop: '1rem'}} />
                    <button onClick={handleTranscribe} disabled={!file || isLoading} style={{...styles.button, ...( !file || isLoading ? styles.buttonDisabled : {}), display: 'block' }}>
                        {isLoading && status.startsWith('Transcribiendo') ? 'Transcribiendo...' : 'Transcribir'}
                    </button>
                </div>
                
                <p style={styles.status}>{status}</p>

                {transcription && (
                    <div style={styles.card}>
                        <h2>2. Transcripción</h2>
                        <textarea style={styles.textarea} value={transcription} readOnly />
                        {!generalSummary && (
                            <button onClick={handleGenerateGeneralSummary} disabled={isLoading} style={{...styles.button, ...(isLoading ? styles.buttonDisabled : {})}}>
                                {isLoading && status.startsWith('Generando resumen general') ? 'Generando...' : 'Generar Resumen General'}
                            </button>
                        )}
                    </div>
                )}

                {generalSummary && (
                    <div style={styles.card}>
                        <h2>3. Resumen General</h2>
                        <textarea style={styles.textarea} value={generalSummary} readOnly />
                        {!businessSummary && (
                             <button onClick={handleGenerateBusinessSummary} disabled={isLoading} style={{...styles.button, ...(isLoading ? styles.buttonDisabled : {})}}>
                                {isLoading && status.startsWith('Generando resumen de negocio') ? 'Generando...' : 'Generar Resumen de Negocio'}
                            </button>
                        )}
                    </div>
                )}

                {businessSummary && (
                    <div style={styles.card}>
                        <h2>4. Resumen de Negocio</h2>
                        {file && <p style={styles.filenameDisplay}>Archivo: {file.name}</p>}
                        <textarea 
                            style={styles.textarea} 
                            value={businessSummary}
                            onChange={(e) => setBusinessSummary(e.target.value)}
                        />
                        <div style={{marginTop: '1.5rem', borderTop: '1px solid #eee', paddingTop: '1.5rem'}}>
                            <h3>Mejorar Resumen de Negocio</h3>
                            <p>Proporciona una instrucción para refinar el resumen anterior.</p>
                            <textarea
                                style={{...styles.textarea, minHeight: '80px'}}
                                placeholder="Ej: 'El cliente se llama Juan Pérez, no Juan Ramírez' o 'Enfócate más en el precio del pulpo'"
                                value={improvementInstruction}
                                onChange={(e) => setImprovementInstruction(e.target.value)}
                            />
                            <button onClick={toggleRecording} style={{...styles.button, backgroundColor: isRecording ? '#fa3e3e' : '#42b72a'}}>
                                {isRecording ? 'Detener Grabación' : 'Grabar Instrucciones'}
                            </button>
                            <div style={{marginTop: '1rem'}}>
                                <button onClick={() => handleImproveSummary(false)} disabled={isLoading} style={{...styles.button, ...(isLoading ? styles.buttonDisabled : {})}}>
                                    Aplicar Mejora Temporal
                                </button>
                                <button onClick={() => handleImproveSummary(true)} disabled={isLoading} style={{...styles.button, ...(isLoading ? styles.buttonDisabled : {}), marginLeft: '1rem', backgroundColor: '#36a420'}}>
                                    Aplicar y Guardar Mejora
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {businessSummary && (
                    <div style={styles.card}>
                        <h2>5. Exportar</h2>
                        <p>Genera un archivo .txt con la transcripción y ambos resúmenes.</p>
                        <button onClick={handleGenerateDocument} style={styles.button}>
                            Generar Documento
                        </button>
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

export default App;
