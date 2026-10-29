import { Component, OnInit, OnDestroy, inject, ChangeDetectorRef, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Subscription, interval } from 'rxjs';
import Swal from 'sweetalert2';

import { CajaService } from '../../core/services/caja.service';
import { AuthService } from '../../core/services/auth.service';
import { Rol } from '../../core/models/rol';
import { Caja, EstadoActualCaja, EstadoCaja, TipoMedioEgreso, EgresoCajaResponse } from '../../core/models/caja';

@Component({
  selector: 'app-caja',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './caja.component.html',
  styleUrls: ['./caja.component.css'],
})
export class CajaComponent implements OnInit, OnDestroy {
  private fb = inject(FormBuilder);
  private cajaService = inject(CajaService);
  private cdr = inject(ChangeDetectorRef);
  private ngZone = inject(NgZone);
  private authService = inject(AuthService);


  get esRoot(): boolean {
    return this.authService.esRoot();
  }

  get puedeVerHistorial(): boolean {
    const rol = this.authService.obtenerUsuario()?.rol;
    return this.esRoot || rol === Rol.ADMIN || rol === Rol.SUPER_ADMIN;
  }

  get puedeRegistrarEgreso(): boolean {
    const rol = this.authService.obtenerUsuario()?.rol;
    return this.esRoot || rol === Rol.ADMIN || rol === Rol.SUPER_ADMIN;
  }

  EstadoCaja = EstadoCaja;
  TipoMedioEgreso = TipoMedioEgreso;

  // Carga ultra-rápida (cero lag como en módulo productos)
  cargando: boolean = false;
  cargandoEstado: boolean = false;
  cargandoHistorial: boolean = false;
  procesando: boolean = false;
  cargandoEgresos: boolean = false;

  // Monitoreo en tiempo real para Root
  private timerRealtime?: Subscription;
  private subCajaModificada?: Subscription;
  ultimaActualizacionEnVivo: Date = new Date();
  monitoreoActivo: boolean = true;
  fechaImpresion: Date = new Date();

  estadoActual?: EstadoActualCaja;
  egresosTurno: EgresoCajaResponse[] = [];
  historial: Caja[] = [];

  // Último turno cerrado para que Root siempre vea la plata incluso con caja cerrada
  get ultimoTurnoCerrado(): Caja | undefined {
    return this.historial && this.historial.length > 0 ? this.historial[0] : undefined;
  }

  get diferenciaUltimoTurnoCerrado(): number {
    return Number(this.ultimoTurnoCerrado?.diferencia || 0);
  }

  // Paginación historial
  currentPage: number = 0;
  pageSize: number = 3;
  totalElements: number = 0;
  totalPages: number = 0;

  // Modales
  mostrarModalApertura: boolean = false;
  mostrarModalCierre: boolean = false;
  mostrarModalEgreso: boolean = false;
  mostrarModalComprobante: boolean = false;
  comprobanteSeleccionado: Caja | null = null;

  // Formularios reactivos
  formApertura: FormGroup;
  formCierre: FormGroup;
  formEgreso: FormGroup;

  constructor() {
    this.formApertura = this.fb.group({
      montoInicial: [0, [Validators.required, Validators.min(0)]],
      observaciones: ['', [Validators.maxLength(500)]],
    });

    this.formCierre = this.fb.group({
      montoEfectivo: [null, [Validators.required, Validators.min(0)]],
      observaciones: ['', [Validators.maxLength(500)]],
    });

    // Cero lag: respuesta en tiempo real al ingresar montos
    this.formCierre.valueChanges.subscribe(() => {
      this.cdr.detectChanges();
    });

    this.formEgreso = this.fb.group({
      monto: [null, [Validators.required, Validators.min(0.01)]],
      tipoMedio: [TipoMedioEgreso.EFECTIVO, [Validators.required]],
      motivo: ['', [Validators.required, Validators.maxLength(255)]],
      comprobante: ['', [Validators.maxLength(100)]],
    });
  }

  ngOnInit(): void {
    this.cargarDatos();
    this.iniciarMonitoreoTiempoReal();
  }

  ngOnDestroy(): void {
    this.detenerMonitoreoTiempoReal();
  }

  iniciarMonitoreoTiempoReal(): void {
    this.detenerMonitoreoTiempoReal();
    if (!this.monitoreoActivo) return;

    // 1. Canal reactivo para actualizarse al instante si se produce una venta o movimiento en la app
    this.subCajaModificada = this.cajaService.cajaModificada$.subscribe(() => {
      this.actualizarEstadoSilencioso();
    });

    // 2. Monitoreo constante en vivo cada 1.5 segundos (tiempo real genuino, sin exigir clicks ni mover el mouse)
    this.timerRealtime = interval(1500).subscribe(() => {
      if (
        !this.procesando &&
        !this.mostrarModalCierre &&
        !this.mostrarModalApertura &&
        !this.mostrarModalEgreso
      ) {
        this.actualizarEstadoSilencioso();
      }
    });
  }

  actualizarEstadoSilencioso(): void {
    this.cajaService.obtenerEstadoActual().subscribe({
      next: (res) => {
        if (res.data) {
          const antesAbierta = this.estadoActual?.abierta;
          const ahoraAbierta = res.data.abierta;
          this.estadoActual = res.data;
          this.ultimaActualizacionEnVivo = new Date();

          if (ahoraAbierta) {
            this.cajaService.listarEgresosActual().subscribe({
              next: (egr) => {
                this.egresosTurno = egr.data || [];
                this.cdr.detectChanges();
              },
              error: () => {
                this.cdr.detectChanges();
              }
            });
          } else {
            this.egresosTurno = [];
            if (antesAbierta === true && !ahoraAbierta && this.puedeVerHistorial) {
              this.cargarHistorial();
            }
          }

          this.cdr.detectChanges();
        }
      },
      error: () => {
        // En segundo plano no interrumpimos al operador
      },
    });
  }

  detenerMonitoreoTiempoReal(): void {
    if (this.timerRealtime) {
      this.timerRealtime.unsubscribe();
      this.timerRealtime = undefined;
    }
    if (this.subCajaModificada) {
      this.subCajaModificada.unsubscribe();
      this.subCajaModificada = undefined;
    }
  }

  cargarDatos(): void {
    if (!this.estadoActual) {
      this.cargandoEstado = true;
    }
    this.cdr.detectChanges();

    // 1. Obtener estado actual de la caja de inmediato (cero retardo para usuario root y cajeros)
    this.cajaService.obtenerEstadoActual().subscribe({
      next: (res) => {
        this.estadoActual = res.data;
        this.cargando = false;
        this.cargandoEstado = false;
        this.ultimaActualizacionEnVivo = new Date();

        if (this.estadoActual?.abierta) {
          this.cargarEgresosTurno();
        } else {
          this.egresosTurno = [];
        }
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.cargando = false;
        this.cargandoEstado = false;
        this.cdr.detectChanges();
        Swal.fire({
          icon: 'error',
          title: 'Error de conexión',
          text: err.error?.message || 'No se pudo obtener el estado de la caja.',
        });
      },
    });

    // 2. Cargar historial en paralelo (no bloquea las tarjetas principales de dinero)
    if (this.puedeVerHistorial) {
      this.cargarHistorial();
    }
  }

  cargarEgresosTurno(): void {
    this.cargandoEgresos = true;
    this.cajaService.listarEgresosActual().subscribe({
      next: (res) => {
        this.egresosTurno = res.data || [];
        this.cargandoEgresos = false;
        this.cdr.detectChanges();
      },
      error: () => {
        this.cargandoEgresos = false;
        this.cdr.detectChanges();
      }
    });
  }

  cargarHistorial(): void {
    this.cargandoHistorial = true;
    this.cdr.detectChanges();

    this.cajaService.listarHistorial(this.currentPage, this.pageSize).subscribe({
      next: (res) => {
        this.historial = res.data?.content || [];
        this.totalElements = res.data?.totalElements || 0;
        this.totalPages = res.data?.totalPages || 0;
        this.cargandoHistorial = false;
        this.cdr.detectChanges();
      },
      error: () => {
        this.cargandoHistorial = false;
        this.cdr.detectChanges();
      },
    });
  }

  abrirModalApertura(): void {
    this.formApertura.reset({ montoInicial: 0, observaciones: '' });
    this.mostrarModalApertura = true;
    this.cdr.detectChanges();
  }

  cerrarModalApertura(): void {
    this.mostrarModalApertura = false;
    this.cdr.detectChanges();
  }

  abrirModalEgreso(): void {
    if (!this.puedeRegistrarEgreso) {
      Swal.fire('Acceso Denegado', 'Solo administradores o root pueden registrar egresos de dinero.', 'error');
      return;
    }
    if (!this.estadoActual?.abierta) {
      Swal.fire('Atención', 'No se puede registrar un egreso porque no hay ninguna caja abierta.', 'warning');
      return;
    }
    this.formEgreso.reset({
      monto: null,
      tipoMedio: TipoMedioEgreso.EFECTIVO,
      motivo: '',
      comprobante: '',
    });
    this.mostrarModalEgreso = true;
    this.cdr.detectChanges();
  }

  cerrarModalEgreso(): void {
    this.mostrarModalEgreso = false;
    this.cdr.detectChanges();
  }

  confirmarEgreso(): void {
    if (!this.puedeRegistrarEgreso) {
      Swal.fire('Acceso Denegado', 'Solo administradores o root pueden registrar egresos de dinero.', 'error');
      return;
    }
    if (this.formEgreso.invalid || this.procesando) {
      this.formEgreso.markAllAsTouched();
      return;
    }

    const val = this.formEgreso.value;
    Swal.fire({
      title: '¿Confirmar egreso de dinero?',
      html: `¿Registrar salida de <strong>$${Number(val.monto).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</strong> por <strong>${val.tipoMedio}</strong>?<br><small class="text-muted">${val.motivo}</small>`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Sí, registrar egreso',
      cancelButtonText: 'Cancelar',
      confirmButtonColor: '#e67e22',
    }).then((result) => {
      if (result.isConfirmed) {
        this.procesando = true;
        this.cerrarModalEgreso();
        Swal.showLoading();

        this.cajaService.registrarEgreso(val).subscribe({
          next: () => {
            this.procesando = false;
            Swal.fire({
              icon: 'success',
              title: 'Egreso registrado',
              text: 'La salida de dinero fue registrada y sellada en la blockchain con éxito.',
              timer: 2000,
              showConfirmButton: false,
            });
            this.cargarDatos();
          },
          error: (err) => {
            this.procesando = false;
            Swal.fire({
              icon: 'error',
              title: 'No se pudo registrar el egreso',
              text: err.error?.message || 'Error al procesar la salida de caja.',
            });
            this.cdr.detectChanges();
          },
        });
      }
    });
  }

  get efectivoEsperado(): number {
    const inicial = Number(this.estadoActual?.caja?.montoInicial || 0);
    const ventasEfectivo = Number(this.estadoActual?.totalEfectivoActual || 0);
    const egresosEfectivo = Number(this.estadoActual?.totalEgresosEfectivoActual || 0);
    return Math.max(0, inicial + ventasEfectivo - egresosEfectivo);
  }

  get totalDigitalNeto(): number {
    const digital = Number(this.estadoActual?.totalDigitalActual || 0);
    const egresosDigital = Number(this.estadoActual?.totalEgresosTransferenciaActual || 0);
    return Math.max(0, digital - egresosDigital);
  }

  get totalTransferenciasNeto(): number {
    const transf = Number(this.estadoActual?.totalTransferenciaActual || 0);
    const egresosTransf = Number(this.estadoActual?.totalEgresosTransferenciaActual || 0);
    return Math.max(0, transf - egresosTransf);
  }

  get totalConsolidadoEsperado(): number {
    return this.efectivoEsperado + this.totalDigitalNeto;
  }

  abrirModalCierre(): void {
    // Sincronizar de inmediato el estado actual con el servidor antes de abrir el modal para garantizar cifras exactas al segundo
    this.cajaService.obtenerEstadoActual().subscribe({
      next: (res) => {
        if (res.data) {
          this.estadoActual = res.data;
        }
        this.configurarFormularioCierre();
      },
      error: () => {
        this.configurarFormularioCierre();
      },
    });
  }

  private configurarFormularioCierre(): void {
    this.formCierre.reset({
      montoEfectivo: null,
      observaciones: '',
    });
    this.mostrarModalCierre = true;
    this.cdr.detectChanges();
  }

  get conteoIngresado(): boolean {
    const val = this.formCierre.get('montoEfectivo')?.value;
    return val !== null && val !== '' && !isNaN(Number(val));
  }

  onEfectivoInput(): void {
    this.cdr.detectChanges();
  }

  cerrarModalCierre(): void {
    this.mostrarModalCierre = false;
    this.cdr.detectChanges();
  }

  get efectivoContado(): number {
    return Number(this.formCierre.get('montoEfectivo')?.value || 0);
  }

  get diferenciaEfectivo(): number {
    return this.efectivoContado - this.efectivoEsperado;
  }

  get totalRendidoCalculado(): number {
    return this.efectivoContado + this.totalDigitalNeto;
  }

  confirmarApertura(): void {
    if (this.formApertura.invalid) {
      this.formApertura.markAllAsTouched();
      return;
    }

    const { montoInicial, observaciones } = this.formApertura.value;

    Swal.fire({
      title: '¿Confirmar Apertura de Caja?',
      text: `Se iniciará un nuevo turno con un monto inicial de $${Number(montoInicial).toLocaleString('es-AR', { minimumFractionDigits: 2 })}.`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'Sí, abrir caja',
      cancelButtonText: 'Cancelar',
      confirmButtonColor: '#198754',
    }).then((result) => {
      if (result.isConfirmed) {
        this.procesando = true;
        this.cdr.detectChanges();

        this.cajaService.abrir({ montoInicial: Number(montoInicial), observaciones }).subscribe({
          next: () => {
            this.procesando = false;
            this.mostrarModalApertura = false;
            Swal.fire({
              icon: 'success',
              title: 'Caja Abierta',
              text: 'La caja se abrió correctamente.',
              timer: 2000,
              showConfirmButton: false,
            });
            this.cargarDatos();
          },
          error: (err) => {
            this.procesando = false;
            this.cdr.detectChanges();
            Swal.fire({
              icon: 'error',
              title: 'No se pudo abrir la caja',
              text: err.error?.message || 'Ocurrió un error inesperado.',
            });
          },
        });
      }
    });
  }

  confirmarCierre(): void {
    if (this.formCierre.invalid || this.procesando) {
      this.formCierre.markAllAsTouched();
      return;
    }

    const { montoEfectivo, observaciones } = this.formCierre.value;
    const dif = this.diferenciaEfectivo;
    let mensajeDiferencia = 'Arqueo de efectivo exacto (sin diferencias).';

    if (dif > 0) {
      mensajeDiferencia = `Sobrante en efectivo: +$${dif.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
    } else if (dif < 0) {
      mensajeDiferencia = `Faltante en efectivo: -$${Math.abs(dif).toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
    }

    Swal.fire({
      title: '¿Confirmar Cierre de Turno?',
      html: `
        <div style="text-align: left; font-size: 14px; line-height: 1.6; padding: 4px 8px;">
          <p class="mb-1"><strong>Efectivo en Caja a Rendir:</strong> $${Number(montoEfectivo).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</p>
          <p class="mb-1"><strong>Pagos Digitales (Tarj/Transf):</strong> $${this.totalDigitalNeto.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</p>
          <hr style="margin: 8px 0; border-color: rgba(255,255,255,0.2);" />
          <p class="mb-1"><strong>Total Rendido Turno:</strong> $${(Number(montoEfectivo) + this.totalDigitalNeto).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</p>
          <p class="mb-0 ${dif === 0 ? 'text-success' : 'text-warning'} fw-bold">${mensajeDiferencia}</p>
        </div>
      `,
      icon: dif !== 0 ? 'warning' : 'question',
      showCancelButton: true,
      confirmButtonText: 'Sí, cerrar turno ahora',
      cancelButtonText: 'Cancelar',
      confirmButtonColor: '#8b5cf6',
      cancelButtonColor: '#6c757d',
    }).then((result) => {
      if (result.isConfirmed) {
        this.procesando = true;
        this.mostrarModalCierre = false;
        this.cdr.detectChanges();

        Swal.fire({
          title: 'Cerrando caja...',
          text: 'Consolidando turnos y sellando arqueo en blockchain...',
          allowOutsideClick: false,
          didOpen: () => {
            Swal.showLoading();
          },
        });

        this.cajaService.cerrar({ montoEfectivo: Number(montoEfectivo), observaciones }).subscribe({
          next: (res) => {
            this.procesando = false;
            this.estadoActual = {
              abierta: false,
              caja: undefined,
              montoVentasActual: 0,
              montoEsperadoActual: 0,
              totalEfectivoActual: 0,
              totalDebitoActual: 0,
              totalCreditoActual: 0,
              totalTransferenciaActual: 0,
              totalDigitalActual: 0,
              cantidadVentasActual: 0,
            };
            this.currentPage = 0;
            this.cargarHistorial();
            this.cdr.detectChanges();

            Swal.fire({
              icon: 'success',
              title: 'Caja Cerrada Exitosamente',
              html: 'El turno finalizó correctamente. ¿Deseas ver e imprimir el comprobante de turno?',
              showCancelButton: true,
              confirmButtonText: '<i class="fa-solid fa-print"></i> Ver e Imprimir Comprobante',
              cancelButtonText: 'Cerrar',
              confirmButtonColor: '#8b5cf6',
            }).then((swalResult) => {
              if (swalResult.isConfirmed && res.data) {
                this.verComprobante(res.data);
              }
            });
          },
          error: (err) => {
            this.procesando = false;
            this.mostrarModalCierre = true;
            this.cdr.detectChanges();
            Swal.fire({
              icon: 'error',
              title: 'Error al cerrar caja',
              text: err.error?.message || 'No se pudo realizar el cierre.',
            });
          },
        });
      }
    });
  }

  verComprobante(caja: Caja): void {
    if (!caja.id) return;
    this.comprobanteSeleccionado = caja;
    this.fechaImpresion = new Date();
    this.mostrarModalComprobante = true;
    this.cdr.detectChanges();

    // Sincronizar datos detallados con el backend en segundo plano
    this.cajaService.obtenerPorId(caja.id).subscribe({
      next: (res) => {
        if (res.data) {
          this.comprobanteSeleccionado = res.data;
          this.cdr.detectChanges();
        }
      },
      error: () => {
        // Mantiene la caja previa
      }
    });
  }

  cerrarModalComprobante(): void {
    this.mostrarModalComprobante = false;
    this.comprobanteSeleccionado = null;
    this.cdr.detectChanges();
  }

  // Cálculos robustos para el ticket imprimible (sin NaN ni inconsistencias)
  obtenerEfectivoEsperadoTicket(caja?: Caja | null): number {
    if (!caja) return 0;
    const inicial = Number(caja.montoInicial || 0);
    const efectivo = Number(caja.totalEfectivo || 0);
    const egresos = Number(caja.totalEgresosEfectivo || 0);
    return Math.max(0, inicial + efectivo - egresos);
  }

  obtenerEfectivoContadoTicket(caja?: Caja | null): number {
    if (!caja) return 0;
    const esperado = this.obtenerEfectivoEsperadoTicket(caja);
    const dif = Number(caja.diferencia || 0);
    return Math.max(0, esperado + dif);
  }

  obtenerCobrosDigitalesNetosTicket(caja?: Caja | null): number {
    if (!caja) return 0;
    const digital = Number(caja.totalDigital || 0);
    const egresosTransf = Number(caja.totalEgresosTransferencia || 0);
    return Math.max(0, digital - egresosTransf);
  }

  obtenerTotalRendidoTicket(caja?: Caja | null): number {
    if (!caja) return 0;
    if (caja.montoFinal !== null && caja.montoFinal !== undefined) {
      return Number(caja.montoFinal);
    }
    return this.obtenerEfectivoContadoTicket(caja) + this.obtenerCobrosDigitalesNetosTicket(caja);
  }

  /**
   * Imprime el comprobante mediante un iframe invisible aislado.
   * Resuelve al 100% el problema de hojas cortadas o que "salga cualquier cosa",
   * garantizando salida limpia en impresoras térmicas (80mm) y convencionales (A4/Carta).
   */
  imprimirComprobante(): void {
    const ticketElement = document.getElementById('ticket-cierre-impresion');
    if (!ticketElement) {
      window.print();
      return;
    }

    const ticketHtml = ticketElement.innerHTML;
    const turnoId = this.comprobanteSeleccionado?.id || 'Turno';

    let printFrame = document.getElementById('ticket-print-iframe') as HTMLIFrameElement;
    if (printFrame) {
      document.body.removeChild(printFrame);
    }

    printFrame = document.createElement('iframe');
    printFrame.id = 'ticket-print-iframe';
    printFrame.style.position = 'fixed';
    printFrame.style.right = '0';
    printFrame.style.bottom = '0';
    printFrame.style.width = '0';
    printFrame.style.height = '0';
    printFrame.style.border = '0';
    document.body.appendChild(printFrame);

    const frameDoc = printFrame.contentWindow?.document || printFrame.contentDocument;
    if (!frameDoc) {
      window.print();
      return;
    }

    frameDoc.open();
    frameDoc.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Comprobante_Cierre_Caja_${turnoId}</title>
          <style>
            @page {
              size: 80mm auto;
              margin: 4mm;
            }
            * {
              box-sizing: border-box;
              margin: 0;
              padding: 0;
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
            }
            body {
              font-family: 'Courier New', Courier, monospace;
              background: #ffffff !important;
              color: #000000 !important;
              font-size: 12px;
              line-height: 1.35;
              padding: 6px;
              width: 100%;
              max-width: 78mm;
              margin: 0 auto;
            }
            .ticket-header {
              text-align: center;
              margin-bottom: 8px;
            }
            .ticket-brand {
              font-size: 18px;
              font-weight: 900;
              letter-spacing: 1px;
            }
            .ticket-sub {
              font-size: 9px;
              color: #333333;
              margin-top: 2px;
            }
            .ticket-title {
              font-size: 12px;
              font-weight: 800;
              margin-top: 6px;
            }
            .ticket-divider, .ticket-divider-dot {
              font-size: 11px;
              text-align: center;
              margin: 5px 0;
              letter-spacing: -1px;
              color: #333333;
            }
            .ticket-meta, .ticket-section {
              margin-bottom: 8px;
            }
            .ticket-section-title {
              font-size: 11px;
              font-weight: 800;
              text-transform: uppercase;
              margin-bottom: 4px;
              border-bottom: 1px dashed #333;
              padding-bottom: 2px;
            }
            .ticket-row {
              display: flex;
              justify-content: space-between;
              font-size: 11.5px;
              margin: 3px 0;
            }
            .ticket-row-bold {
              font-weight: 900;
              font-size: 12.5px;
            }
            .small-text {
              font-size: 10px;
              color: #444444;
            }
            .ticket-obs {
              font-size: 10.5px;
              font-style: italic;
              background: #f5f5f5;
              padding: 4px 6px;
              border-left: 2px solid #333;
              margin-top: 3px;
            }
            .ticket-firmas {
              display: flex;
              justify-content: space-between;
              gap: 15px;
              margin-top: 24px;
              padding-top: 8px;
              page-break-inside: avoid;
            }
            .firma-box {
              flex: 1;
              text-align: center;
            }
            .firma-espacio-blanco {
              height: 38px;
            }
            .firma-line {
              font-size: 10px;
              letter-spacing: -1px;
            }
            .firma-label {
              font-size: 10px;
              font-weight: bold;
              margin-top: 3px;
            }
            .firma-aclaracion {
              font-size: 9px;
              color: #444;
              margin-top: 2px;
            }
            .ticket-footer {
              text-align: center;
              font-size: 9px;
              color: #555555;
              margin-top: 14px;
              border-top: 1px solid #ddd;
              padding-top: 6px;
              page-break-inside: avoid;
            }
          </style>
        </head>
        <body>
          <div class="ticket-cierre-wrapper">
            ${ticketHtml}
          </div>
        </body>
      </html>
    `);
    frameDoc.close();

    setTimeout(() => {
      try {
        printFrame.contentWindow?.focus();
        printFrame.contentWindow?.print();
      } catch (e) {
        console.error('Error al imprimir comprobante vía iframe:', e);
        window.print();
      }
    }, 200);
  }

  cambiarPagina(nuevaPagina: number): void {
    if (nuevaPagina >= 0 && nuevaPagina < this.totalPages) {
      this.currentPage = nuevaPagina;
      this.cargarHistorial();
    }
  }
}
