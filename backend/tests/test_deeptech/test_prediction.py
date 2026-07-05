from app.deeptech.algorithms.core_algorithm import IYEModel

def test_iye_model_prediction():
    model = IYEModel()
    res = model.predict([1.0, 2.0, 3.0])
    assert res == [1.5, 3.0, 4.5]
