import os
import uvicorn
from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
import google.generativeai as genai
# Importamos las variables (Enums) correctas para la seguridad
from google.generativeai.types import HarmCategory, HarmBlockThreshold
from pydantic import BaseModel, Field
from dotenv import load_dotenv

# --- Configuración ---
load_dotenv() 
genai.configure(api_key=os.getenv("GEMINI_API_KEY"))
app = FastAPI()

# --- Configuración de Seguridad (CORS) ---
origins = ["*"] # Esto significa "permitir todas las conexiones"
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Lista de Seguridad Corregida ---
safety_settings = [
    {"category": HarmCategory.HARM_CATEGORY_HATE_SPEECH, "threshold": HarmBlockThreshold.BLOCK_NONE},
    {"category": HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, "threshold": HarmBlockThreshold.BLOCK_NONE},
    {"category": HarmCategory.HARM_CATEGORY_HARASSMENT, "threshold": HarmBlockThreshold.BLOCK_NONE},
    {"category": HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, "threshold": HarmBlockThreshold.BLOCK_NONE},
]

# --- Modelos de Datos (Pydantic) ---
class GeneralSummaryRequest(BaseModel):
    transcription: str

class BusinessSummaryRequest(BaseModel):
    transcription: str
    instructions: list[str] = Field(default_factory=list) # Recibirá la lista de instrucciones

class ImproveRequest(BaseModel):
    transcription: str
    summary: str
    instruction_text: str
    instructions: list[str] = Field(default_factory=list)

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
        
        model = genai.GenerativeModel(
            model_name="gemini-2.5-flash", 
            safety_settings=safety_settings
        )
        
        response = await model.generate_content_async(
            ["Transcribe this audio recording.", audio_part]
        )

        return {"transcription": response.text}

    except Exception as e:
        print(f"Error en /transcribe: {e}")
        raise HTTPException(status_code=500, detail=str(e)) 
    finally:
        await file.close()

@app.post("/summarize-general")
async def summarize_general(request: GeneralSummaryRequest):
    if not request.transcription:
        raise HTTPException(status_code=400, detail="No se proporcionó transcripción.")

    try:
        prompt = f"""Basado en la siguiente transcripción de una llamada, genera un resumen general claro y conciso. El resumen debe identificar los puntos clave, las acciones a seguir y el sentimiento general de la llamada, sin asumir ningún contexto de negocio específico.
        
        Transcripción:
        ---
        {request.transcription}
        ---
        """
        
        model = genai.GenerativeModel(
            model_name="gemini-2.5-pro",
            safety_settings=safety_settings
        )
        
        response = await model.generate_content_async(prompt)
        
        return {"summary": response.text}

    except Exception as e:
        print(f"Error en /summarize-general: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# --- ================================== ---
# ---       NUEVO ENDPOINT AÑADIDO       ---
# --- ================================== ---
@app.post("/summarize-business")
async def summarize_business(request: BusinessSummaryRequest):
    """
    Recibe transcripción e instrucciones permanentes para generar un resumen de negocio.
    """
    if not request.transcription:
        raise HTTPException(status_code=400, detail="No se proporcionó transcripción.")

    try:
        # Replicamos la lógica de tu App.tsx original
        permanent_instructions_text = ""
        if request.instructions: # Si la lista de instrucciones no está vacía
            instructions_joined = ". ".join(request.instructions)
            permanent_instructions_text = f"Para este resumen, aplica estas reglas e instrucciones permanentes en todo momento: {instructions_joined}"

        # El mismo prompt de negocio que tenías
        prompt = f"""Basado en la siguiente transcripción de una llamada, genera un resumen de negocio claro y conciso. El resumen debe identificar los puntos clave y las acciones a seguir, enfocándose en temas relevantes para un negocio de mariscos.
        
        {permanent_instructions_text}

        Transcripción:
        ---
        {request.transcription}
        ---
        """
        
        model = genai.GenerativeModel(
            model_name="gemini-2.5-pro",
            safety_settings=safety_settings
        )
        
        response = await model.generate_content_async(prompt)
        
        return {"summary": response.text}

    except Exception as e:
        print(f"Error en /summarize-business: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# --- (¡Solo nos falta /improve!) ---

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)