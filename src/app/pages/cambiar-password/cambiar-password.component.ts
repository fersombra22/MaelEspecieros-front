import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import Swal from 'sweetalert2';

import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-cambiar-password',

  standalone: true,

  imports: [CommonModule, FormsModule],

  templateUrl: './cambiar-password.component.html',

  styleUrls: ['./cambiar-password.component.css'],
})
export class CambiarPasswordComponent {
  private authService = inject(AuthService);

  private router = inject(Router);

  passwordActual = '';

  passwordNueva = '';

  confirmarPassword = '';

  mostrarPasswordActual = false;

  mostrarPasswordNueva = false;

  mostrarConfirmarPassword = false;

  get tieneLongitudMinima(): boolean {
    return this.passwordNueva.length >= 8;
  }

  get tieneMayuscula(): boolean {
    return /[A-Z]/.test(this.passwordNueva);
  }

  get tieneMinuscula(): boolean {
    return /[a-z]/.test(this.passwordNueva);
  }

  get tieneNumero(): boolean {
    return /\d/.test(this.passwordNueva);
  }

  get coincidenPasswords(): boolean {
    return this.confirmarPassword.length > 0 && this.passwordNueva === this.confirmarPassword;
  }

  get esDiferenteDeActual(): boolean {
    return !this.passwordActual || !this.passwordNueva || this.passwordNueva !== this.passwordActual;
  }

  get passwordValida(): boolean {
    return (
      this.tieneLongitudMinima &&
      this.tieneMayuscula &&
      this.tieneMinuscula &&
      this.tieneNumero &&
      this.coincidenPasswords &&
      this.esDiferenteDeActual
    );
  }

  cambiarPassword() {
    if (!this.passwordActual) {
      Swal.fire({
        icon: 'warning',
        title: 'Contraseña Actual Requerida',
        text: 'Por favor ingrese su contraseña actual.',
      });
      return;
    }

    if (!this.tieneLongitudMinima || !this.tieneMayuscula || !this.tieneMinuscula || !this.tieneNumero) {
      Swal.fire({
        icon: 'warning',
        title: 'Requisitos de Seguridad',
        text: 'La nueva contraseña debe tener al menos 8 caracteres y contener letras mayúsculas, minúsculas y números.',
      });
      return;
    }

    if (!this.esDiferenteDeActual) {
      Swal.fire({
        icon: 'warning',
        title: 'Contraseña Repetida',
        text: 'La nueva contraseña debe ser diferente a la contraseña actual.',
      });
      return;
    }

    if (this.passwordNueva !== this.confirmarPassword) {
      Swal.fire({
        icon: 'warning',
        title: 'Contraseñas no coinciden',
        text: 'La confirmación de la contraseña no coincide con la nueva contraseña.',
      });
      return;
    }

    const usuario = this.authService.obtenerUsuario();

    if (!usuario) {
      Swal.fire({
        icon: 'error',

        title: 'Error',

        text: 'No existe usuario temporal.',
      });

      return;
    }

    const request = {
      username: usuario.username,

      passwordActual: this.passwordActual,

      passwordNueva: this.passwordNueva,
    };

    this.authService
      .cambiarPassword(request)

      .subscribe({
        next: () => {
          Swal.fire({
            icon: 'success',

            title: 'Correcto',

            text: 'Contraseña cambiada. Ingrese nuevamente.',
          })

            .then(() => {
              this.authService.cerrarSesion();

              this.router.navigate(['/login']);
            });
        },

        error: (error) => {
          Swal.fire({
            icon: 'error',

            title: 'Error',

            text: error.error.message ?? 'No se pudo cambiar la contraseña.',
          });
        },
      });
  }
}
