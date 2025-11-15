import os
import uvicorn
import io
import json 
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import google.generativeai as genai
from pydantic import BaseModel, Field
from dotenv import load_dotenv

# --- Importaciones de Google Drive ---
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload, MediaInMemoryUpload
from datetime import datetime 
# --- Fin de Importaciones ---


# --- Configuración ---
if os.getenv("RENDER") != "true":
    load_dotenv() 

genai.configure(api_key=os.getenv("GEMINI_API_KEY"))

# --- Configuración de Google Drive ---
SERVICE_ACCOUNT_JSON_STRING = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON")
FOLDER_ID_M4A_DESTINATION = os.getenv("FOLDER_ID_M4A_DESTINATION")
FOLDER_ID_TXT_DESTINATION = os.getenv("FOLDER_ID_TXT_DESTINATION")

SCOPES = ['https://www.googleapis.com/auth/drive'] 

creds = None
drive_service = None

if not all([SERVICE_ACCOUNT_JSON_STRING, FOLDER_ID_M4A_DESTINATION, FOLDER_ID_TXT_DESTINATION, os.getenv("GEMINI_API_KEY")]):
    print("ADVERTENCIA: Faltan una o más variables de entorno (JSON, M4A_DEST, TXT_DEST o GEMINI_API_KEY).")
else:
    try:
        SERVICE_ACCOUNT_INFO = json.loads(SERVICE_ACCOUNT_JSON_STRING)
        creds = service_account.Credentials.from_service_account_info(
            SERVICE_ACCOUNT_INFO, scopes=SCOPES
        )
        drive_service = build('drive', 'v3', credentials=creds)
        print("Servicio de Google Drive y credenciales cargados exitosamente.")
    except Exception as e:
        print(f"Error al cargar credenciales de Google Drive: {e}")

app = FastAPI()

# --- Configuración de Seguridad (CORS) ---
origins = [
    "https://mj-transcripciones.vercel.app", 
    "http://localhost:5173", 
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Lista de Seguridad Corregida ---
safety_settings = [
    {"category": genai.types.HarmCategory.HARM_CATEGORY_HATE_SPEECH, "threshold": genai.types.HarmBlockThreshold.BLOCK_NONE},
    {"category": genai.types.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, "threshold": genai.types.HarmBlockThreshold.BLOCK_NONE},
    {"category": genai.types.HarmCategory.HARM_CATEGORY_HARASSMENT, "threshold": genai.types.HarmBlockThreshold.BLOCK_NONE},
    {"category": genai.types.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, "threshold": genai.types.HarmBlockThreshold.BLOCK_NONE}
]

# --- Modelos de Datos (Pydantic) ---
class GeneralSummaryRequest(BaseModel):
    transcription: str

class BusinessSummaryRequest(BaseModel):
    transcription: str
    instructions: list[str] = Field(default_factory=list)

class DriveRequest(BaseModel):
    drive_file_id: str
    instructions: list[str] = Field(default_factory=list) 

# --- Función Helper para el contenido del TXT ---
def generate_document_content(file_name: str, transcription: str, general_summary: str, business_summary: str) -> str:
    fecha_procesamiento = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return f"""
=========================================
REGISTRO DE LLAMADA
=========================================

Archivo Original: {file_name}
Fecha de Procesamiento: {fecha_procesamiento}

-----------------------------------------
1. TRANSCRIPCIÓN COMPLETA
-----------------------------------------

{transcription}

-----------------------------------------
2. RESUMEN GENERAL DE LA LLAMADA
-----------------------------------------

{general_summary}

-----------------------------------------
3. RESUMEN DE NEGOCIO (PARA NOTAS RÁPIDAS)
-----------------------------------------

{business_summary}
    """.strip()

# --- Endpoints (Las "URLs" de nuestra API) ---

@app.get("/")
def read_root():
    return {"status": "MJTranscripciones Backend ¡funcionando!"}

@app.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    if not file:
        raise HTTPException(status_code=400, detail="No se subió ningún archivo.")
    try:
        audio_part = {
            "mime_type": file.content_type,
            "data": await file.read()
        }
        model = genai.GenerativeModel(model_name="gemini-2.5-flash", safety_settings=safety_settings)
        response = await model.generate_content_async(["Transcribe this audio recording.", audio_part])
        return {"transcription": response.text, "fileName": file.filename}
    except Exception as e:
        print(f"Error en /transcribe: {e}")
        raise HTTPException(status_code=500, detail=str(e)) 
    finally:
        if file:
            await file.close()

@app.post("/transcribe-from-drive")
async def transcribe_from_drive(request: DriveRequest):
    if not drive_service:
        raise HTTPException(status_code=500, detail="Servicio de Google Drive no configurado. Revisa las variables de entorno.")
    if not all([FOLDER_ID_M4A_DESTINATION, FOLDER_ID_TXT_DESTINATION]):
        raise HTTPException(status_code=500, detail="IDs de carpetas de destino no configurados en el backend.")

    try:
        file_id = request.drive_file_id
        
        file_metadata = drive_service.files().get(fileId=file_id, fields='mimeType, name, parents').execute()
        mime_type = file_metadata.get('mimeType')
        original_name = file_metadata.get('name')
        
        if mime_type == 'application/vnd.google-apps.folder':
            print(f"Error: El ID {file_id} es de una CARPETA, no de un archivo.")
            raise HTTPException(status_code=400, detail="Error: El link es de una CARPETA, no de un archivo. Por favor, copia el link del archivo .m4a")

        original_parent = file_metadata.get('parents')[0] 
        
        new_name = original_name
        if original_name.startswith("Grabacion de llamada "):
            new_name = original_name.replace("Grabacion de llamada ", "", 1)
            print(f"Renombrando: '{original_name}' -> '{new_name}'")
        
        print(f"Descargando: {new_name} ({mime_type})")
        drive_request = drive_service.files().get_media(fileId=file_id)
        file_bytes_io = io.BytesIO()
        downloader = MediaIoBaseDownload(file_bytes_io, drive_request)
        done = False
        while done is False:
            status, done = downloader.next_chunk()

        # --- ================================== ---
        # ---      ¡AQUÍ ESTÁ EL ARREGLO!        ---
        # --- ================================== ---
        # Forzamos el mime_type si es 3gpp, ya que sabemos que es audio m4a
        if mime_type == 'video/3gpp' or mime_type == 'audio/3gpp':
            print(f"Tipo MIME '{mime_type}' detectado. Forzando a 'audio/m4a' para Gemini.")
            mime_type = 'audio/m4a'
        # --- ================================== ---

        print("Transcribiendo...")
        audio_part = { "mime_type": mime_type, "data": file_bytes_io.getvalue() }
        model_flash = genai.GenerativeModel(model_name="gemini-2.5-flash", safety_settings=safety_settings)
        
        response_flash = await model_flash.generate_content_async(["Transcribe this audio recording.", audio_part])
        transcription = response_flash.text

        print("Generando Resumen General...")
        prompt_general = f"""Basado en la siguiente transcripción de una llamada, genera un resumen general claro y conciso...
        Transcripción:
        ---
        {transcription}
        ---
        """
        model_pro = genai.GenerativeModel(model_name="gemini-2.5-pro", safety_settings=safety_settings)
        response_general = await model_pro.generate_content_async(prompt_general)
        general_summary = response_general.text

        print("Generando Resumen de Negocio...")
        permanent_instructions_text = ""
        if request.instructions:
            instructions_joined = ". ".join(request.instructions)
            permanent_instructions_text = f"Para este resumen, aplica estas reglas e instrucciones permanentes en todo momento: {instructions_joined}"
        
        prompt_business = f"""Basado en la siguiente transcripción de una llamada, genera un resumen de negocio claro y conciso...
        {permanent_instructions_text}
        Transcripción:
        ---
        {transcription}
        ---
        """
        response_business = await model_pro.generate_content_async(prompt_business)
        business_summary = response_business.text

        print(f"Creando archivo .txt en carpeta {FOLDER_ID_TXT_DESTINATION}...")
        txt_content = generate_document_content(new_name, transcription, general_summary, business_summary)
        txt_filename = f"{new_name.split('.')[0]}.txt"
        
        txt_media = MediaInMemoryUpload(txt_content.encode('utf-8'), mimetype='text/plain')
        drive_service.files().create(
            body={'name': txt_filename, 'parents': [FOLDER_ID_TXT_DESTINATION]},
            media_body=txt_media
        ).execute()

        print(f"Moviendo .m4a a carpeta {FOLDER_ID_M4A_DESTINATION}...")
        drive_service.files().update(
            fileId=file_id,
            addParents=FOLDER_ID_M4A_DESTINATION,
            removeParents=original_parent,
            body={'name': new_name} 
        ).execute()

        print(f"Proceso completado para: {new_name}")
        return {
            "fileName": new_name,
            "transcription": transcription,
            "generalSummary": general_summary,
            "businessSummary": business_summary
        }

    except Exception as e:
        print(f"Error en /transcribe-from-drive: {e}")
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/summarize-general")
async def summarize_general(request: GeneralSummaryRequest):
    print("Llamada a /summarize-general (flujo local)")
    try:
        prompt = f"""Basado en la siguiente transcripción de una llamada, genera un resumen general claro y conciso...
        Transcripción:
        ---
        {request.transcription}
        ---
        """
        model = genai.GenerativeModel(model_name="gemini-2.5-pro", safety_settings=safety_settings)
        response = await model.generate_content_async(prompt)
        return {"summary": response.text}
    except Exception as e:
        print(f"Error en /summarize-general: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/summarize-business")
async def summarize_business(request: BusinessSummaryRequest):
    print("Llamada a /summarize-business (flujo local)")
    try:
        permanent_instructions_text = ""
        if request.instructions:
            instructions_joined = ". ".join(request.instructions)
            permanent_instructions_text = f"Para este resumen, aplica estas reglas e instrucciones permanentes en todo momento: {instructions_joined}"

        prompt = f"""Basado en la siguiente transcripción de una llamada, genera un resumen de negocio claro y conciso...
        {permanent_instructions_text}
        Transcripción:
        ---
        {request.transcription}
        ---
        """
        model = genai.GenerativeModel(model_name="gemini-2.5-pro", safety_settings=safety_settings)
        response = await model.generate_content_async(prompt)
        return {"summary": response.text}
    except Exception as e:
        print(f"Error en /summarize-business: {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)