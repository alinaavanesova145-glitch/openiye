from fastapi import APIRouter
from pydantic import BaseModel
from app.deeptech.algorithms.core_algorithm import IYEModel

router = APIRouter()

class InferenceRequest(BaseModel):
    data: list[float]

class InferenceResponse(BaseModel):
    prediction: list[float]
    confidence: float

@router.post("", response_model=InferenceResponse)
async def run_inference(request: InferenceRequest):
    model = IYEModel()
    result = model.predict(request.data)
    return {
        "prediction": result,
        "confidence": 0.99
    }
