import pytest
from pydantic import ValidationError

from app import CanvasMatrixResponse


def test_canvas_matrix_validation_valid():
    matrix = CanvasMatrixResponse(
        matrix_data=[1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
        prediction_id="test-id"
    )
    assert len(matrix.matrix_data) == 9

def test_canvas_matrix_validation_invalid():
    with pytest.raises(ValidationError):
        CanvasMatrixResponse(
            matrix_data=[1.0, 0.0, 0.0],
            prediction_id="test-id"
        )
