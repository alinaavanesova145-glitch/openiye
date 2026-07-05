# Empty package marker
from pydantic import BaseModel, field_validator


class CanvasMatrixResponse(BaseModel):
    matrix_data: list[float]
    prediction_id: str

    @field_validator('matrix_data')
    @classmethod
    def validate_three_by_three(cls, value: list[float]) -> list[float]:
        # ensure the flat array represents a valid 3x3 transformation matrix (9 elements)
        if len(value) != 9:
            raise ValueError("matrix_data must contain exactly 9 flat float values for a 3x3 matrix.")
        return value
