# Español: términos y estilo

Cómo se traducen las palabras propias de Rclone UI, para que toda la app diga lo mismo. Las
reglas generales están en `locales/README.md`.

## Estilo

- Tuteo: «tú», nunca «usted». Imperativo en botones y pasos: «Elige», «Pulsa», «Escribe».
- Español neutro e internacional: nada que suene a un solo país («ordenador» y «computadora»
  se evitan con «equipo»; «archivo», no «fichero»).
- Mayúscula solo en la primera palabra y en los nombres propios: «Iniciar copia», no
  «Iniciar Copia».
- Signos de apertura: «¿…?» y «¡…!».
- Frases cortas y directas, como en una buena app actual. Se traduce el sentido, no palabra por
  palabra.
- Comillas: “…”, las mismas que usan macOS y Windows en español.
- Un aviso de algo que no se hizo («Schedule not paused», «Couldn't unmount») empieza por «No se
  pudo»: «No se pudo pausar la tarea programada».
- Las horas van en formato de 24 horas: «a las 02:00».
- No se traducen: Rclone UI, rclone, WinFsp, los nombres de los servicios (Google Drive, S3),
  las opciones de rclone (`--dry-run`), sus valores (`10M`, `1h30m`), las rutas ni los nombres
  de los remotos.

## Términos

| Inglés | Español | Nota |
|---|---|---|
| remote | remoto | «Remotos» es el título de la ventana. |
| mount (verbo) | montar | |
| mount (nombre) | montaje | «Montajes (2)». |
| mount point | punto de montaje | |
| unmount | desmontar | |
| automount | montaje automático | |
| serve (verbo) | servir | Título de la ventana: «Servir». |
| serve (nombre) | servidor | «Servidores (2)», «Detener el servidor». |
| sync | sincronizar, sincronización | |
| bisync | Bisync (el) | Es el nombre del comando de rclone. Se explica como «sincronización en ambos sentidos». |
| copy | copiar | |
| move | mover | |
| delete | eliminar | Como en macOS y Windows. |
| purge | purgar | Elimina la carpeta y todo su contenido. |
| download | descargar, descarga | |
| upload | subir, subida | |
| transfer | transferencia | |
| template | plantilla | |
| watcher | observador | Vigila dos carpetas y las sincroniza cuando cambian. |
| schedule (nombre) | tarea programada | «Tareas programadas» es el título de la ventana. |
| schedule (verbo) | programar | |
| Commander | Commander | Nombre de la ventana. |
| launcher | lanzador | |
| history | historial | |
| settings | configuración | |
| guide | guía | |
| notification | notificación | |
| dry run, preview | simulación, vista previa | «Vista previa» en el menú; «simulación» al explicarlo. |
| option | opción | |
| flag | opción | Con su nombre de rclone tal cual: `--dry-run`. |
| cache | caché (la) | |
| config (de rclone) | configuración de rclone | El archivo es «rclone.conf». |
| password | contraseña | |
| folder | carpeta | |
| file | archivo | |
| path | ruta | |
| source | origen | |
| destination | destino | |
| tray | bandeja del sistema | En macOS, «barra de menús». |
| this computer | este equipo | |
| las operaciones como nombres | copia, movimiento, sincronización, eliminación, purga, descarga, montaje, servidor | «Nueva copia», «Iniciar movimiento», «Bisync iniciado». |
| command | comando | «Copiar comando». |
| command line | línea de comandos | |
| baseline (bisync) | línea base | |
| Config (grupo de opciones generales de rclone) | General | «Configuración» ya es la de la app y el archivo rclone.conf. |
| encrypt / encrypted | cifrar / cifrado | |
| unlock / locked | desbloquear / bloqueado | |
| system keychain | llavero del sistema | |
| shortcut | atajo | |
| sign in | iniciar sesión | «Sesión caducada». |
| reconnect | reconectar | |
| browse | explorar | |
| logs | registros | |
| favorites | favoritos | |
| default | predeterminado | |
| Check for updates | Buscar actualizaciones | |
| wizard | asistente | |
| place (una ubicación del asistente) | ubicación | |
| step | paso | «Paso 2 de 5». |
| metadata / field / rule | metadatos / campo / regla | |
| drive (letra de unidad) | unidad | |
| share / link | compartir / enlace | |
| tunnel / QR code | túnel / código QR | |
| phone | teléfono | |
| disable | desactivar | |
| Finder / File Explorer | Finder / Explorador de archivos | |
| run (una ejecución de una tarea) | ejecución | «Próxima ejecución: mañana». |
| merge (carpetas) | combinar | Como lo dice Windows. |
| resync | resincronizar | |
| duplicate | duplicar | |
| every weekday | de lunes a viernes | |
| custom | personalizado | |
| cron expression | expresión cron | |
| filters | filtros | |
| add / edit | añadir / editar | |
| Disk Usage | Uso de disco | Nombre de la herramienta del Commander. Analiza todo un remoto o un disco: «analizar», «Analizando…», «Volver a analizar». |
| AI agent / agent | agente de IA / agente | Una app como Claude Code o Cursor que usa Rclone UI por ti. «Agentes» es el grupo de Configuración. |
| MCP | MCP | El protocolo con el que se conectan los agentes. No se traduce. |
| token | token (el) | El que envían las apps que se conectan por la dirección. «Nuevo token». |
| port | puerto | |
| header (HTTP) | encabezado | El nombre del encabezado, `Authorization`, no se traduce. |
| address (de un servidor) | dirección | La URL a la que se conecta una app. |
| OK / Cancel / Close | Aceptar / Cancelar / Cerrar | |
| Open / Quit / Retry | Abrir / Salir / Reintentar | |
