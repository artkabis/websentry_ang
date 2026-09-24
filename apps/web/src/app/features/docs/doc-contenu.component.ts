import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { DocBlock, DocInline } from '@websentry/shared';

/** Identifiant de page visé par un lien interne, ou `null` si le lien est externe. */
export function slugInterne(href: string): string | null {
  return href.startsWith('doc:') ? href.slice('doc:'.length) : null;
}

/**
 * Rendu d'une suite de fragments en ligne.
 *
 * Aucun `innerHTML`, nulle part : chaque fragment est une donnée typée que le
 * gabarit dessine avec ses propres balises. Le texte passe donc toujours par
 * l'interpolation d'Angular, qui l'échappe — il n'y a rien à désinfecter parce
 * qu'il n'y a rien à interpréter.
 */
@Component({
  selector: 'ws-doc-inline',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (fragment of contenu(); track $index) {
      @switch (fragment.type) {
        @case ('fort') {
          <strong class="font-semibold text-content">{{ fragment.texte }}</strong>
        }
        @case ('code') {
          <code class="rounded bg-sunken px-1 py-0.5 font-mono text-[0.85em] text-content">{{
            fragment.texte
          }}</code>
        }
        @case ('lien') {
          @if (slug(fragment); as cible) {
            <a
              [routerLink]="['/aide', cible]"
              class="rounded text-brand-text underline underline-offset-2 hover:no-underline
                     focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
                     focus-visible:outline-brand-text"
              >{{ fragment.texte }}</a
            >
          } @else {
            <!-- L'attribut noopener coupe l'accès de la page ouverte à window.opener ;
                 l'icône n'est pas décorative : elle prévient qu'on quitte
                 l'application, ce que le seul soulignement ne dit pas. -->
            <a
              [href]="fragment.href"
              target="_blank"
              rel="noopener noreferrer"
              class="rounded text-brand-text underline underline-offset-2 hover:no-underline
                     focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
                     focus-visible:outline-brand-text"
              >{{ fragment.texte }}<span class="sr-only"> (nouvel onglet)</span
              ><span aria-hidden="true"> ↗</span></a
            >
          }
        }
        @default {
          {{ fragment.texte }}
        }
      }
    }
  `,
})
export class DocInlineComponent {
  readonly contenu = input.required<readonly DocInline[]>();

  /**
   * Le gabarit n'appelle cette méthode que sous `@case ('lien')`, où le
   * fragment est déjà réduit à cette variante. Accepter `DocInline` entier
   * obligerait à un `type === 'lien'` défensif — une branche qu'aucun rendu ne
   * peut atteindre, donc un test creux à écrire pour la couvrir.
   */
  slug(fragment: Extract<DocInline, { type: 'lien' }>): string | null {
    return slugInterne(fragment.href);
  }
}

/**
 * Rendu d'une page : la suite de blocs, dessinée par des gabarits fermés.
 *
 * Les titres portent leur ancre en `id` — c'est ce qui rend le sommaire
 * latéral et les liens profonds possibles sans calcul côté client.
 */
@Component({
  selector: 'ws-doc-blocs',
  standalone: true,
  imports: [DocInlineComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (bloc of blocs(); track $index) {
      @switch (bloc.type) {
        @case ('titre') {
          @if (bloc.niveau === 2) {
            <h2 [id]="bloc.ancre" class="mt-8 scroll-mt-24 text-lg font-semibold text-content">
              {{ bloc.texte }}
            </h2>
          } @else {
            <h3 [id]="bloc.ancre" class="mt-6 scroll-mt-24 text-base font-semibold text-content">
              {{ bloc.texte }}
            </h3>
          }
        }
        @case ('paragraphe') {
          <p class="mt-3 text-sm leading-relaxed text-content-muted">
            <ws-doc-inline [contenu]="bloc.contenu" />
          </p>
        }
        @case ('liste') {
          @if (bloc.ordonnee) {
            <ol
              class="mt-3 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-content-muted"
            >
              @for (element of bloc.elements; track $index) {
                <li><ws-doc-inline [contenu]="element" /></li>
              }
            </ol>
          } @else {
            <ul class="mt-3 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-content-muted">
              @for (element of bloc.elements; track $index) {
                <li><ws-doc-inline [contenu]="element" /></li>
              }
            </ul>
          }
        }
        @case ('code') {
          <pre
            class="mt-3 overflow-x-auto rounded-lg bg-sunken p-3 text-xs text-content"
            [attr.data-langage]="bloc.langage"
            tabindex="0"
          ><code>{{ bloc.texte }}</code></pre>
        }
        @case ('note') {
          <!-- Le ton n'est pas porté par la seule couleur : le mot « Note » ou
               « Attention » le dit, et le lecteur d'écran l'entend. -->
          <aside
            class="mt-4 rounded-lg p-4 ring-1"
            [class]="
              bloc.ton === 'avertissement'
                ? 'bg-warn-surface ring-warn-solid/30'
                : 'bg-panel ring-line'
            "
          >
            <p
              class="text-xs font-semibold uppercase tracking-wide"
              [class]="bloc.ton === 'avertissement' ? 'text-warn-content' : 'text-content-subtle'"
            >
              {{ bloc.ton === 'avertissement' ? 'Attention' : 'Note' }}
            </p>
            <p class="mt-1 text-sm leading-relaxed text-content-muted">
              <ws-doc-inline [contenu]="bloc.contenu" />
            </p>
          </aside>
        }
      }
    }
  `,
})
export class DocBlocsComponent {
  readonly blocs = input.required<readonly DocBlock[]>();
}
