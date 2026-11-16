"""Trigger PreSignUp de Cognito: confirma automáticamente el registro (entorno académico/demo).

Evita depender de la entrega de correos (SES sandbox) durante la demostración.
En producción se eliminaría este trigger y se exigiría verificar el correo.
"""


def handler(event, _context):
    event["response"]["autoConfirmUser"] = True
    if "email" in event["request"].get("userAttributes", {}):
        event["response"]["autoVerifyEmail"] = True
    return event
