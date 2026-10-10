---
description: Estándares de calidad de código para Python, C++, JavaScript y proyectos de hardware/IoT.
---

# Estándares de Desarrollo de Código

- **Tipado y Claridad**: Prioriza código limpio, modular y legible. En Python, utiliza anotaciones de tipos (*type hints*) donde sea útil. En C++ (ej. ESP32), mantén el uso de memoria eficiente y manejo de excepciones claro.
- **Sin código fantasma**: No inventes funciones, métodos ni librerías que no existan en la versión estándar de la librería o lenguaje que estás usando. Si tienes dudas, usa la implementación más robusta y estándar.
- **Manejo de errores**: Todo bloque crítico de red, lectura de sensores (IoT) o llamadas a bases de datos (SQLite/Flask) debe incluir manejo de excepciones (`try/except` o equivalentes) para evitar caídas silenciosas.